import express, { Request, Response } from "express";
import path from "path";
import fs from "fs";
import os from "os";
import multer from "multer";
import dotenv from "dotenv";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

dotenv.config();

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

// Set up file uploads using multer in /tmp
const upload = multer({ dest: os.tmpdir() });

// Helper to retrieve live lazy-loaded GoogleGenAI client
function getAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("서버 환경 변수에 GEMINI_API_KEY가 존재하지 않습니다.");
  }
  return new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: { 'User-Agent': 'aistudio-build' }
    }
  });
}

// Configure standard express parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper function to search or create the Google Drive folder "AI 회의록 자동화"
async function getOrCreateFolder(accessToken: string): Promise<string | null> {
  // If an administrator configured a static shared drive or folder ID, use it directly!
  if (process.env.SHARED_DRIVE_FOLDER_ID) {
    console.log(`Using configured shared drive folder ID: ${process.env.SHARED_DRIVE_FOLDER_ID}`);
    return process.env.SHARED_DRIVE_FOLDER_ID;
  }

  const folderName = "AI 회의록";
  try {
    // 1. Search for folder with support for shared drives
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.folder'+and+name='${encodeURIComponent(folderName)}'+and+trashed=false&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!searchRes.ok) {
      const errText = await searchRes.text();
      if (searchRes.status === 401) {
        console.log("[Auth] Google OAuth token status is 401 (unauthorized) during folder search.");
        throw new Error("401: Google OAuth Token Expired");
      }
      console.error("Failed to search folder in Google Drive:", errText);
      return null;
    }

    const searchData = await searchRes.json();
    if (searchData.files && searchData.files.length > 0) {
      return searchData.files[0].id;
    }

    // 2. Folder not found, create it (enabling all drives support)
    console.log("Folder not found. Creating a new folder in Google Drive...");
    const createRes = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
      }),
    });

    if (!createRes.ok) {
       const errText = await createRes.text();
       if (createRes.status === 401) {
         console.log("[Auth] Google OAuth token status is 401 (unauthorized) during folder creation.");
         throw new Error("401: Google OAuth Token Expired");
       }
       console.error("Failed to create folder in Google Drive:", errText);
       return null;
     }

    const createData = await createRes.json();
    return createData.id;
  } catch (error: any) {
    if (error && error.message && error.message.includes("401")) {
      throw error;
    }
    console.error("Error in getOrCreateFolder:", error);
    return null;
  }
}

interface JobState {
  id: string;
  status: "processing" | "completed" | "failed";
  progress: number;
  message: string;
  result?: {
    documentId: string;
    documentUrl: string;
    audioUrl: string | null;
    structuredNotes: any;
    transcript: string;
  };
  error?: string;
}

const jobs = new Map<string, JobState>();

// Helper function to handle Google GenAI model calls with robust exponential backoff retry for transient errors (e.g., 503 unavailable)
async function generateContentWithRetry(aiClient: any, params: any, maxRetries = 3, initialDelay = 2000): Promise<any> {
  const initialModel = params.model || "gemini-3.5-flash";
  const fallbackModels = ["gemini-3.5-flash", "gemini-flash-latest", "gemini-3.1-flash-lite"];
  // Filter out the initialModel so we can try it first, then try the others in order
  const modelOrder = [initialModel, ...fallbackModels.filter(m => m !== initialModel)];

  let attempt = 0;
  let modelIndex = 0;

  while (modelIndex < modelOrder.length) {
    const currentModel = modelOrder[modelIndex];
    const currentParams = { ...params, model: currentModel };
    
    try {
      if (currentModel !== initialModel) {
        console.info(`[Gemini API] Falling back and trying model: ${currentModel}`);
      }
      return await aiClient.models.generateContent(currentParams);
    } catch (error: any) {
      attempt++;
      const errorStr = error ? (error.message || JSON.stringify(error)) : "";
      const isTransient = error && (
        error.status === 503 ||
        error.status === 429 ||
        error.status === 500 ||
        errorStr.includes("503") ||
        errorStr.includes("429") ||
        errorStr.includes("500") ||
        errorStr.includes("high demand") ||
        errorStr.includes("temp_unavailable") ||
        errorStr.includes("UNAVAILABLE") ||
        errorStr.includes("overloaded")
      );
      
      if (isTransient) {
        if (attempt < maxRetries) {
          const delay = initialDelay * Math.pow(2, attempt - 1) * (0.8 + Math.random() * 0.4); // Exponential backoff with jitter
          console.warn(`[Gemini API] Received transient error for ${currentModel} (attempt ${attempt}/${maxRetries}). Retrying in ${Math.round(delay)}ms. Error:`, errorStr);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          // If we exhausted retries for this model, fall back to the next model in the list
          if (modelIndex + 1 < modelOrder.length) {
            console.warn(`[Gemini API] Model ${currentModel} failed after ${attempt} attempts with transient error. Falling back to next candidate model...`);
            modelIndex++;
            attempt = 0; // Reset attempt count for the next model
          } else {
            console.error(`[Gemini API] All candidate models exhausted. Failed after ${attempt} attempts on ${currentModel}:`, errorStr);
            throw error;
          }
        }
      } else {
        // If we encounter a non-transient error (like unsupported model or invalid argument on this model),
        // try the next fallback model in case this model is currently restricted/deprecated.
        if (modelIndex + 1 < modelOrder.length) {
          console.warn(`[Gemini API] Model ${currentModel} failed with non-transient error. Falling back to next candidate model. Error:`, errorStr);
          modelIndex++;
          attempt = 0; // Reset attempt count for the next model
        } else {
          console.error(`[Gemini API] Non-transient error for model ${currentModel}:`, errorStr);
          throw error;
        }
      }
    }
  }
  
  throw new Error("All candidate Gemini models are currently experiencing high demand. Please try again later.");
}

// Async background processing worker to handle Gemini API & Google Drive syncing
async function processAudioJob(
  jobId: string,
  tempFilePath: string,
  originalFilename: string,
  fileSize: number,
  mimetype: string,
  accessToken: string
) {
  let uploadedGenAIFile: any = null;

  try {
    let creationDateStr = "";
    let yymmdd = "";
    try {
      const kstFormatter = new Intl.DateTimeFormat('ko-KR', {
        timeZone: 'Asia/Seoul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      });
      const formatted = kstFormatter.format(new Date());
      const parts = formatted.replace(/\./g, "").split(" ").map(p => p.trim()).filter(Boolean);
      if (parts.length === 3) {
        creationDateStr = `${parts[0]}-${parts[1]}-${parts[2]}`;
        yymmdd = parts[0].slice(2) + parts[1] + parts[2];
      }
    } catch (e) {
      console.warn("KST formatter failed, falling back to standard Date:", e);
    }

    if (!creationDateStr || !yymmdd) {
      const d = new Date();
      const yyyy = String(d.getFullYear());
      const yy = yyyy.slice(2);
      const mm = String(d.getMonth() + 1).padStart(2, '0');
      const dd = String(d.getDate()).padStart(2, '0');
      creationDateStr = `${yyyy}-${mm}-${dd}`;
      yymmdd = yy + mm + dd;
    }

    const updateJob = (progress: number, message: string) => {
      console.log(`[Job ${jobId}] Progress: ${progress}%, Message: ${message}`);
      const job = jobs.get(jobId);
      if (job) {
        job.progress = progress;
        job.message = message;
      }
    };

    updateJob(5, "음성 파일 분석을 준비하고 있습니다...");

    // Standard fallback mime mapping if webm audio format
    let mimeType = mimetype;
    if (mimeType === "application/octet-stream" || !mimeType) {
      mimeType = "audio/webm";
    }

    const aiClient = getAIClient();
    updateJob(15, "구글 Gemini AI 분석 엔진에 음성 데이터를 안전하게 업로드 중입니다...");
    uploadedGenAIFile = await aiClient.files.upload({
      file: tempFilePath,
      config: {
        mimeType: mimeType,
      }
    });

    console.log(`Gemini File API Upload success. File Name: ${uploadedGenAIFile.name}`);

    // Wait for the file to be processed and become ACTIVE
    let fileState = "PROCESSING";
    let attempts = 0;
    while (fileState === "PROCESSING" && attempts < 30) {
      updateJob(
        Math.min(15 + attempts * 2, 40),
        `Gemini AI에서 고해상도 음성 신호를 분석 중입니다... (대기시간 ${attempts * 2}초)`
      );
      try {
        const fileInfo = await aiClient.files.get({ name: uploadedGenAIFile.name });
        fileState = fileInfo.state || "ACTIVE";
        console.log(`Current file state: ${fileState}`);
        if (fileState === "FAILED") {
          throw new Error("Gemini File API에 음성 파일 업로드 후 처리가 실패했습니다.");
        }
        if (fileState === "ACTIVE") {
          break;
        }
      } catch (getErr) {
        console.warn("Error checking file state, continuing to poll...", getErr);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
      attempts++;
    }

    updateJob(45, "음성 파일을 텍스트로 정밀하게 받아적고 구조화된 안건을 도출하는 중입니다...");

    // Prepare structure-driven prompt with JSON response requirement
    const systemPrompt = `당신은 스타트업 및 IT 프로덕트 개발 회의의 전사 스크립트를 분석하여, 실행 중심의 고도로 구조화된 '수석 비즈니스 회의록'을 작성하는 전문 비서이자 비즈니스 라이터입니다.
제공된 한국어 음성 데이터를 정밀 분석하고, 회의의 맥락, 결정된 사항의 인과관계, 그리고 즉시 실행 가능한 액션 아이템(To-Do)이 명확히 드러나는 최고급 비즈니스 회의록을 생성해 주십시오.

[작성 가이드라인]
1. 논의사항과 결정사항의 분리:
   - "discussion"(주요 논의사항)에는 아이디어가 오간 과정, 겪고 있는 문제점, 기술적 한계나 예외 상황 등의 '맥락'을 풍부하게 서술하십시오. (예: 어떤 배경에서 이슈가 발생했으며, 참석자 간에 어떤 의견이 대립하거나 개진되었는지 상세 서술)
   - "decision"(결정사항)에는 논의 끝에 최종적으로 합의된 결론만 명확하고 간결하게 요약하십시오.
2. 구체적인 액션 아이템(Todo Lists) 도출:
   - '누가(담당자)', '무엇을(작업 내용)', '언제까지(기한)' 해야 하는지 명확히 매핑하십시오.
   - 대화 중에서 언급된 날짜나 요일(예: "다음 주 월요일", "수요일 런칭")을 회의 일자 및 현재 날짜를 기준으로 역산하여 구체적인 날짜(YYYY-MM-DD)로 변환하여 기입하십시오. 기한이 명시되지 않았다면 'TBD(추후 확정)' 또는 맥락상 유추 가능한 일정을 적으십시오.
3. 문체 및 톤앤매너:
   - 전문적이고 신뢰감 있는 비즈니스 격식체(존칭 및 명사형 종결 어미 혼용)를 사용하십시오.
   - 불필요한 구어체나 감정적 표현은 배제하고, 객관적 사실과 실행 위주로 정리하십시오.
4. 원본 데이터의 보존:
   - 회의 데이터 내의 날짜, 인명, 수치, 핵심 팩트를 왜곡, 축소, 임의 생략하지 말고 완벽히 기재하십시오.

제공된 한국어 음성 파일을 바탕으로 분석한 뒤, 다음 필드를 포함하는 완벽한 JSON 형식으로 회의록을 도출해 주세요. JSON 이외의 설명이나 구분 기호, 코드 블록 마크다운은 배제하고 순수한 JSON 데이터만 제공하세요.

객체 필드:
- "title": 회의의 주요 명제 및 주제를 논의 상태에 맞추어 명쾌하게 뽑아낸 수석 비즈니스 회의록 보고서 제목 (예: "단위 변환 기능 및 1차 출시 일정 조율 회의")
- "date": 회의 발생 일자 (YYYY-MM-DD 형식으로 분석하여 기입, 음성에서 유추 불가하거나 언급이 없다면 오늘 날짜인 ${creationDateStr} 기입)
- "attendees": 참석자 이름 목록 (음성 내 대화자 및 화자를 분석하여 실명 매핑된 참석자 이름의 배열)
- "agenda": 이번 회의에서 다루어진 핵심 안건들을 몇 가지 핵심 키워드로 요약한 리스트
- "discussion": 논의 배경, 발생한 이슈, 기술적 한계, 참석자 간의 다양한 의견(누가 어떤 발언을 했는지)을 맥락 중심으로 상세히 서술한 리스트
- "decision": 논의 끝에 최종적으로 결정된 사안을 깔끔하게 요약한 리스트
- "todo": 향후 각 담당자가 기한 내 처리해야 할 액션 아이템 리스트. 각각 "task"(할 일 내용 - 구체적으로 상세히 기술), "assignee"(담당자 실명, 명확하지 않으면 '미지정'), "dueDate"(YYYY-MM-DD 형식의 구체적 날짜 또는 일정 정보, 명확하지 않으면 'TBD')를 포함하는 객체 배열.
- "transcript": 음성 파일 전체에 대한 상세 전사(녹취) 스크립트. 모든 말소리를 누락과 곡해 없이 한글 구어체 뉘앙스를 고스란히 정교하게 적은 실제 대화 내용입니다. 반드시 녹음 음성의 다양한 목소리 톤과 발화 순간을 분석하여 발화 주체를 구분하고, 대화 형식으로 머리에 "화자이름(또는 실명 매핑이 안될 시 참여자 1, 참여자 2...)" 등 화자 구분(Diarization) 형태의 세그먼트 표기를 줄바꿈과 함께 적용하여 정확하게 전사해 주십시오.`;

    const modelResponse = await generateContentWithRetry(aiClient, {
      model: "gemini-3.5-flash",
      contents: [
        {
          fileData: {
            fileUri: uploadedGenAIFile.uri,
            mimeType: uploadedGenAIFile.mimeType
          }
        },
        systemPrompt
      ],
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: "OBJECT",
          properties: {
            title: { type: "STRING" },
            date: { type: "STRING" },
            attendees: {
              type: "ARRAY",
              items: { type: "STRING" }
            },
            agenda: {
              type: "ARRAY",
              items: { type: "STRING" }
            },
            discussion: {
              type: "ARRAY",
              items: { type: "STRING" }
            },
            decision: {
              type: "ARRAY",
              items: { type: "STRING" }
            },
            todo: {
              type: "ARRAY",
              items: {
                type: "OBJECT",
                properties: {
                  task: { type: "STRING" },
                  assignee: { type: "STRING" },
                  dueDate: { type: "STRING" }
                },
                required: ["task", "assignee", "dueDate"]
              }
            },
            transcript: { type: "STRING" }
          },
          required: ["title", "date", "attendees", "agenda", "discussion", "decision", "todo", "transcript"]
        }
      }
    });

    const outputText = modelResponse.text;
    console.log("Raw response from Gemini Model:", outputText);

    if (!outputText) {
      throw new Error("Gemini 모델로부터 응답 텍스트를 받지 못했습니다.");
    }

    updateJob(65, "AI 회의록 분석 및 가공 결과를 수집하여 표준 규격으로 구조화하는 중입니다...");

    // Clean or Parse Gemini response
    let structuredNotesRaw: any;
    try {
      structuredNotesRaw = JSON.parse(outputText.trim());
    } catch (parseErr) {
      console.warn("JSON direct parse failed. Attempting cleanup...", parseErr);
      const cleanedText = outputText
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      structuredNotesRaw = JSON.parse(cleanedText);
    }

    const ensureArray = (val: any): string[] => {
      if (!val) return [];
      if (Array.isArray(val)) return val;
      if (typeof val === "string") return [val];
      return [];
    };

    const structuredNotes = {
      title: structuredNotesRaw.title || "AI 회의록 보고서",
      date: structuredNotesRaw.date || creationDateStr || new Date().toISOString().split('T')[0],
      attendees: ensureArray(structuredNotesRaw.attendees),
      agenda: ensureArray(structuredNotesRaw.agenda),
      discussion: ensureArray(structuredNotesRaw.discussion),
      decision: ensureArray(structuredNotesRaw.decision),
      todo: Array.isArray(structuredNotesRaw.todo) ? structuredNotesRaw.todo : [],
      transcript: structuredNotesRaw.transcript || ""
    };

    console.log("Normalized Structured Meeting Notes prepared successfully:", structuredNotes);

    updateJob(75, "구글 드라이브(Google Drive)에 회의록 저장 전용 폴더를 탐색 중입니다...");

    // Get or Create Drive folder "AI 회의록"
    const folderId = await getOrCreateFolder(accessToken);
    if (!folderId) {
      console.warn("Google Drive folder retrieval failed. Creating file in Drive root instead.");
    }

    const docTitle = `${yymmdd} / ${structuredNotes.title}`;
    const rawAudioTitle = `${yymmdd} / ${structuredNotes.title}.webm`;

    updateJob(80, "녹음된 원본 음성 파일을 구글 드라이브(Google Drive)에 동기화 업로드 중입니다...");

    let audioFileUrlOnDrive = null;
    let audioFileIdOnDrive = null;
    try {
      if (folderId) {
        console.log(`Uploading raw audio file to Google Drive folder [folderId: ${folderId}]...`);
        const audioBuffer = fs.readFileSync(tempFilePath);
        const audioBoundary = "314159265358979323846";
        const delimiter = `\r\n--${audioBoundary}\r\n`;
        const closeDelimiter = `\r\n--${audioBoundary}--`;

        const audioMetadata = {
          name: rawAudioTitle,
          parents: [folderId],
          mimeType: mimeType || "audio/webm"
        };

        const multipartBody = Buffer.concat([
          Buffer.from(delimiter),
          Buffer.from('Content-Type: application/json; charset=UTF-8\r\n\r\n'),
          Buffer.from(JSON.stringify(audioMetadata)),
          Buffer.from(delimiter),
          Buffer.from(`Content-Type: ${mimeType || "audio/webm"}\r\n\r\n`),
          audioBuffer,
          Buffer.from(closeDelimiter)
        ]);

        const uploadAudioRes = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": `multipart/related; boundary=${audioBoundary}`,
            "Content-Length": String(multipartBody.length)
          },
          body: multipartBody
        });

        if (uploadAudioRes.ok) {
          const audioDriveMeta = await uploadAudioRes.json();
          audioFileIdOnDrive = audioDriveMeta.id;
          console.log(`Audio upload to Drive successful. File ID: ${audioFileIdOnDrive}`);
          
          const getAudioMeta = await fetch(`https://www.googleapis.com/drive/v3/files/${audioFileIdOnDrive}?fields=webViewLink&supportsAllDrives=true`, {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (getAudioMeta.ok) {
            const audioMetaJson = await getAudioMeta.json();
            audioFileUrlOnDrive = audioMetaJson.webViewLink;
          }
        } else {
          const errText = await uploadAudioRes.text();
          console.error("Audio file upload to Google Drive failed:", errText);
        }
      }
    } catch (audioUploadErr) {
      console.error("Exception in audio file upload to Google Drive:", audioUploadErr);
    }

    updateJob(85, "구글 문서도구(Google Docs)에 회의록 서식을 구성하고 작성하는 중입니다...");

    const createDocRes = await fetch("https://www.googleapis.com/drive/v3/files?supportsAllDrives=true", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: docTitle,
        mimeType: "application/vnd.google-apps.document",
        parents: folderId ? [folderId] : undefined,
      }),
    });

    if (!createDocRes.ok) {
      const errText = await createDocRes.text();
      throw new Error(`Google Docs 생성에 실패했습니다: ${errText}`);
    }

    const docMetadata = await createDocRes.json();
    const documentId = docMetadata?.id;

    if (!documentId) {
      throw new Error("Google Docs 생성 과정에서 파일 ID를 획득하지 못했습니다.");
    }

    const attendeesList = structuredNotes.attendees && structuredNotes.attendees.length > 0
      ? structuredNotes.attendees.join(", ")
      : "미지정";

    const formatAgenda = structuredNotes.agenda.map((a: string) => `* ${a}`).join("\n");
    const formatDiscussion = structuredNotes.discussion.map((d: string) => `* ${d}`).join("\n");
    const formatDecision = structuredNotes.decision.map((de: string) => `* ${de}`).join("\n");
    
    // Construct the Todo Markdown table
    let formatTodo = "| 작업 내용 | 담당자 | 기한 |\n| :--- | :--- | :--- |\n";
    if (structuredNotes.todo && structuredNotes.todo.length > 0) {
      formatTodo += structuredNotes.todo.map((t: any) => 
        `| ${t.task} | ${t.assignee || "미지정"} | ${t.dueDate || "TBD"} |`
      ).join("\n");
    } else {
      formatTodo += "| 지정된 할 일이 없습니다. | - | - |";
    }

    const segments: { text: string; style?: "HEADING_1" | "HEADING_2" | "NORMAL_TEXT"; pageBreakBefore?: boolean }[] = [];

    segments.push({
      text: `📝 ${structuredNotes.title || "AI 회의록 자동 생성 보고서"}\n`,
      style: "HEADING_1"
    });

    segments.push({
      text: `📅 회의 일자: ${structuredNotes.date || creationDateStr}\n👥 참석자: ${attendeesList}\n`,
      style: "NORMAL_TEXT"
    });

    segments.push({
      text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`,
      style: "NORMAL_TEXT"
    });

    segments.push({
      text: `### 1. 회의 안건 (Agenda)\n`,
      style: "HEADING_2"
    });
    segments.push({
      text: `${formatAgenda || "* 등록된 안건이 없습니다."}\n\n`,
      style: "NORMAL_TEXT"
    });

    segments.push({
      text: `### 2. 주요 논의사항 (Discussion)\n`,
      style: "HEADING_2"
    });
    segments.push({
      text: `${formatDiscussion || "* 등록된 논의사항이 없습니다."}\n\n`,
      style: "NORMAL_TEXT"
    });

    segments.push({
      text: `### 3. 결정사항 (Decision)\n`,
      style: "HEADING_2"
    });
    segments.push({
      text: `${formatDecision || "* 등록된 결정사항이 없습니다."}\n\n`,
      style: "NORMAL_TEXT"
    });

    segments.push({
      text: `### 4. 향후 할 일 및 후속 조치 (Todo Lists)\n`,
      style: "HEADING_2"
    });
    segments.push({
      text: `${formatTodo}\n\n`,
      style: "NORMAL_TEXT"
    });

    if (audioFileUrlOnDrive) {
      segments.push({
        text: `5. 회의 원본 녹음 링크 (Original Voice Recording)\n`,
        style: "HEADING_2"
      });
      segments.push({
        text: `  • 구글 드라이브 오디오 바로가기: ${audioFileUrlOnDrive}\n\n`,
        style: "NORMAL_TEXT"
      });
    }

    segments.push({
      text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`,
      style: "NORMAL_TEXT"
    });

    segments.push({
      text: `🗣️ 전사 녹취 스크립트 (Full Transcript Appendix)\n`,
      style: "HEADING_1",
      pageBreakBefore: true
    });

    segments.push({
      text: `${structuredNotes.transcript || "대화 기록을 전사하지 못했습니다."}\n\n`,
      style: "NORMAL_TEXT"
    });

    segments.push({
      text: `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`,
      style: "NORMAL_TEXT"
    });

    segments.push({
      text: `본 회의록은 AI 회의록 자동화 웹 서비스를 통해 음성을 정밀 분석하여 자동 기재되었습니다.`,
      style: "NORMAL_TEXT"
    });

    let fullText = "";
    const styleRequests: any[] = [];
    let transcriptIndexInFullText = -1;
    let currentPos = 1;

    for (const seg of segments) {
      const textLen = seg.text.length;
      if (textLen === 0) continue;

      const start = currentPos;
      const end = currentPos + textLen;

      if (seg.pageBreakBefore) {
        transcriptIndexInFullText = start;
      }

      if (seg.style && seg.style !== "NORMAL_TEXT") {
        styleRequests.push({
          updateParagraphStyle: {
            paragraphStyle: {
              namedStyleType: seg.style
            },
            range: {
              startIndex: start,
              endIndex: end
            },
            fields: "namedStyleType"
          }
        });
      }

      fullText += seg.text;
      currentPos += textLen;
    }

    updateJob(90, "작성된 회의록 내용을 구글 문서(Google Docs)에 최종 배치 업로드 중입니다...");

    const requests = [
      {
        insertText: {
          text: fullText,
          location: { index: 1 }
        }
      },
      ...styleRequests
    ];

    if (transcriptIndexInFullText !== -1) {
      requests.push({
        insertPageBreak: {
          location: { index: transcriptIndexInFullText }
        }
      });
    }

    const updateDocsRes = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ requests }),
    });

    if (!updateDocsRes.ok) {
      const errText = await updateDocsRes.text();
      console.error("Docs text insertion failed. The empty Doc remains.", errText);
    } else {
      console.log("Docs content batchUpdate successful!");
    }

    const getFileMeta = await fetch(`https://www.googleapis.com/drive/v3/files/${documentId}?fields=webViewLink&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const fileMetaData = await getFileMeta.json();
    const documentUrl = fileMetaData.webViewLink || `https://docs.google.com/document/d/${documentId}/edit`;

    const job = jobs.get(jobId);
    if (job) {
      job.status = "completed";
      job.progress = 100;
      job.message = "회의록 작성이 완료되었습니다!";
      job.result = {
        documentId: documentId,
        documentUrl: documentUrl,
        audioUrl: audioFileUrlOnDrive,
        structuredNotes: structuredNotes,
        transcript: structuredNotes.transcript || outputText
      };
    }

  } catch (err: any) {
    const isAuthError = err && err.message && (err.message.includes("401") || err.message.includes("authError") || err.message.includes("Invalid Credentials"));
    if (isAuthError) {
      console.warn(`OAuth token expired inside background job ${jobId}.`);
    } else {
      console.error(`Error in background job ${jobId}:`, err);
    }
    const job = jobs.get(jobId);
    if (job) {
      job.status = "failed";
      job.error = isAuthError ? "구글 로그인 세션이 만료되었습니다. 다시 로그인해 주세요." : (err.message || "회의록 분석 중 알 수 없는 에러가 발생했습니다.");
      job.message = "회의록 자동 도출 및 구글 연동 중 에러가 발생했습니다.";
    }
  } finally {
    if (uploadedGenAIFile) {
      try {
        console.log(`Deleting file from Gemini File Storage to free up space: ${uploadedGenAIFile.name}`);
        const aiClient = getAIClient();
        await aiClient.files.delete({ name: uploadedGenAIFile.name });
      } catch (cleanUpErr) {
        console.warn("Failed to clean up Gemini Storage File:", cleanUpErr);
      }
    }

    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
        console.log(`Deleted local temp file successfully: ${tempFilePath}`);
      }
    } catch (fsCleanErr) {
      console.warn("Failed to delete local temp file:", fsCleanErr);
    }
  }
}

// -----------------------------------------------------------------
// 0.5. API - POST /api/meetings/upload-chunk
// Receives an audio file chunk and appends it to a temporary file.
// Used for overcoming the 413 Request Entity Too Large proxy limits.
// -----------------------------------------------------------------
app.post("/api/meetings/upload-chunk", upload.single("chunk"), async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ success: false, error: "구글 로그인 인증 토큰이 필요합니다." });
    return;
  }

  const chunkFile = req.file;
  if (!chunkFile) {
    res.status(400).json({ success: false, error: "전송된 파일 청크가 없습니다." });
    return;
  }

  const { chunkIndex, totalChunks, uploadId } = req.body;
  if (!uploadId || chunkIndex === undefined || totalChunks === undefined) {
    res.status(400).json({ success: false, error: "올바르지 않은 파라미터 구성입니다. (uploadId, chunkIndex, totalChunks 필요)" });
    return;
  }

  const cIndex = parseInt(chunkIndex, 10);
  const tChunks = parseInt(totalChunks, 10);

  // Use a clean and secure unique filename for assembly
  const safeUploadId = uploadId.replace(/[^a-zA-Z0-9_-]/g, "");
  const assembledPath = path.join(os.tmpdir(), `upload_assembled_${safeUploadId}.webm`);

  try {
    const chunkBuffer = fs.readFileSync(chunkFile.path);

    if (cIndex === 0) {
      // Overwrite / Create new file for the first chunk
      fs.writeFileSync(assembledPath, chunkBuffer);
    } else {
      // Append for subsequent chunks
      fs.appendFileSync(assembledPath, chunkBuffer);
    }

    // Clean up the temporary chunk file created by multer
    try {
      fs.unlinkSync(chunkFile.path);
    } catch (err) {
      console.warn(`Failed to delete temporary chunk file ${chunkFile.path}:`, err);
    }

    const isCompleted = cIndex === tChunks - 1;
    res.json({
      success: true,
      completed: isCompleted,
      uploadId: safeUploadId
    });
  } catch (error: any) {
    console.error("Error during chunk upload/assembly:", error);
    res.status(500).json({ success: false, error: "청크 업로드 및 병합 중 오류가 발생했습니다: " + error.message });
  }
});

// -----------------------------------------------------------------
// 1. API - POST /api/meetings/process
// Receives an audio file (direct or chunked-assembled), triggers an asynchronous background job,
// and returns a job status tracking ID (jobId) to prevent connection timeouts.
// -----------------------------------------------------------------
app.post("/api/meetings/process", upload.single("audio"), async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ success: false, error: "구글 로그인 인증 토큰이 필요합니다. (Authorization header missing)" });
    return;
  }

  const accessToken = authHeader.split(" ")[1];

  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({ success: false, error: "서버 설정에 GEMINI_API_KEY 환경 변수가 존재하지 않습니다. AI Studio API Key가 정상 등록되었는지 확인해 주세요." });
    return;
  }

  let tempFilePath = "";
  let originalName = "meeting_record.webm";
  let fileSize = 0;
  let mimetype = "audio/webm";

  // Check if we are doing a chunked-upload process call
  const { uploadId } = req.body;
  if (uploadId) {
    const safeUploadId = uploadId.replace(/[^a-zA-Z0-9_-]/g, "");
    tempFilePath = path.join(os.tmpdir(), `upload_assembled_${safeUploadId}.webm`);
    if (!fs.existsSync(tempFilePath)) {
      res.status(404).json({ success: false, error: "병합 완료된 오디오 파일을 찾을 수 없습니다. 다시 업로드해 주세요." });
      return;
    }
    const stats = fs.statSync(tempFilePath);
    fileSize = stats.size;
  } else {
    // Standard direct file upload fallback
    const audioFile = req.file;
    if (!audioFile) {
      res.status(400).json({ success: false, error: "녹음된 오디오 파일이 전송되지 않았습니다." });
      return;
    }
    tempFilePath = audioFile.path;
    originalName = audioFile.originalname;
    fileSize = audioFile.size;
    mimetype = audioFile.mimetype;
  }

  // Assign a unique jobId for status tracking
  const jobId = `job_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

  jobs.set(jobId, {
    id: jobId,
    status: "processing",
    progress: 5,
    message: "서버에 오디오 파일 전송을 성공적으로 완료했습니다. 분석 작업을 초기화하는 중입니다..."
  });

  // Execute processing task in the background without awaiting
  processAudioJob(
    jobId,
    tempFilePath,
    originalName,
    fileSize,
    mimetype,
    accessToken
  ).catch(err => {
    console.error(`Uncaught background error in processAudioJob for ${jobId}:`, err);
  });

  // Instantly return 202 Accepted with jobId to the client
  res.status(202).json({
    success: true,
    jobId: jobId
  });
});

// -----------------------------------------------------------------
// 1.5. API - GET /api/meetings/status/:jobId
// Returns the real-time background processing status, progress, and error/success outputs.
// -----------------------------------------------------------------
app.get("/api/meetings/status/:jobId", (req: Request, res: Response): void => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);
  if (!job) {
    res.status(404).json({ success: false, error: "요청하신 분석 작업 ID를 찾을 수 없습니다." });
    return;
  }
  res.json({ success: true, job });
});


// -----------------------------------------------------------------
// 2. API - GET /api/meetings/logs
// Queries Google Drive folder for previously saved Google Docs
// to demonstrate active synchronizations and history.
// -----------------------------------------------------------------
app.get("/api/meetings/logs", async (req: Request, res: Response): Promise<void> => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ success: false, error: "Authentication token is required" });
    return;
  }

  const accessToken = authHeader.split(" ")[1];

  try {
    const folderId = await getOrCreateFolder(accessToken);
    if (!folderId) {
      res.json({ success: true, files: [], folderUrl: "https://drive.google.com" });
      return;
    }

    // List docs inside "AI 회의록 자동화" folder with Shared Drive support
    const listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+mimeType='application/vnd.google-apps.document'+and+trashed=false&orderBy=createdTime+desc&fields=files(id,name,webViewLink,createdTime)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!listRes.ok) {
      const errText = await listRes.text();
      if (listRes.status === 401 || errText.includes("authError") || errText.includes("Invalid Credentials")) {
        throw new Error("401: Google OAuth Token Expired");
      }
      throw new Error(`Failed to list docs: ${errText}`);
    }

    const listData = await listRes.json();
    const files = listData.files || [];

    // Get folder webViewLink to dynamically navigate user
    const getFolderMeta = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=webViewLink&supportsAllDrives=true`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    
    if (!getFolderMeta.ok && getFolderMeta.status === 401) {
      throw new Error("401: Google OAuth Token Expired");
    }
    
    const folderMetaData = await getFolderMeta.json();
    const folderUrl = folderMetaData.webViewLink || `https://drive.google.com/drive/folders/${folderId}`;

    res.json({
      success: true,
      files: files,
      folderUrl: folderUrl
    });

  } catch (error: any) {
    const isAuthError = error && error.message && (error.message.includes("401") || error.message.includes("authError") || error.message.includes("Invalid Credentials"));
    if (isAuthError) {
      console.log("[Auth] Google OAuth token is expired or revoked. Responding with 401.");
      res.status(401).json({ success: false, error: "구글 로그인 세션이 만료되었습니다. 다시 로그인해 주세요." });
    } else {
      console.error("Failed to query meeting logs from Drive:", error);
      res.status(500).json({ success: false, error: error.message || "이전 기록을 구글 드라이브로부터 동기화하는 도중 에러가 발생했습니다." });
    }
  }
});


// Global Express Error Handling Middleware
app.use((err: any, req: Request, res: Response, next: any) => {
  console.error("Global Express Error Handler caught an error:", err);
  res.status(err.status || err.statusCode || 500).json({
    success: false,
    error: err.message || "서버 내부 오류가 발생했습니다."
  });
});


// -----------------------------------------------------------------
// Vite Development or Production Static Site Hosting Pipeline
// -----------------------------------------------------------------
async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    // Live Vite development server middleware
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    console.log("Vite hot development server mounted in express.");
  } else {
    // Production static content routing
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
    console.log("Serving static built client assets in production mode.");
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running and listening internally on internal port ${PORT}`);
  });

  // Set server timeouts to 15 minutes (900,000 ms) to support large 1-hour audio uploads & processing
  server.timeout = 900000;
  server.headersTimeout = 900000;
  server.keepAliveTimeout = 900000;
}

startServer();
