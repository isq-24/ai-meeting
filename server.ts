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

    updateJob(45, "음성 파일에서 화자를 식별하며 전사 녹취 스크립트(STT)를 정밀 복원 중입니다...");

    // 1단계: 고정밀 무손실 전사(STT) 수행 (Plain Text 출력으로 JSON 파싱 실패 차단 및 무손실 전사 보장)
    const transcribingPrompt = `당신은 최고 성능의 한국어 음성 전사(STT) 엔진이자 전문 비서입니다.
제공된 오디오의 음성 데이터를 듣고 대화 내용을 단 한 글자도 누락, 왜곡, 축소 또는 임의 생략("중략", "..." 등)하지 말고 100% 빠짐없이 그대로 받아적으십시오.

[지침]
1. 음성 내 대화자의 목소리 톤과 어조를 구별하여 화자를 구분 및 표기하십시오. 만약 실명이 파악된다면 이름으로 표기하고, 파악되지 않는다면 목소리를 구별하여 "참여자 1", "참여자 2..." 등으로 일관성 있게 식별하십시오.
2. 참석자별 발언이 바뀔 때마다 반드시 줄바꿈과 함께 문단 분리(빈 줄 하나 추가, 즉 \\n\\n)를 적용해 가독성을 극대화하여 출력하십시오.
3. 구어체의 뉘앙스와 말소리를 정교하게 복원하십시오.
4. 출력은 어떠한 부가 설명, 서론, 결론 또는 마크다운 코드 블록(예: \`\`\`) 없이 오직 순수한 전사 텍스트 결과물만 반환하십시오.`;

    const transcriptionResponse = await generateContentWithRetry(aiClient, {
      model: "gemini-3.5-flash",
      contents: [
        {
          fileData: {
            fileUri: uploadedGenAIFile.uri,
            mimeType: uploadedGenAIFile.mimeType
          }
        },
        transcribingPrompt
      ]
    });

    const rawTranscript = transcriptionResponse.text;
    console.log("[STT Engine] Completed high-fidelity transcription. Length:", rawTranscript ? rawTranscript.length : 0);

    if (!rawTranscript || rawTranscript.trim().length === 0) {
      throw new Error("음성 파일 전사(STT) 결과물이 비어있거나 생성에 실패했습니다.");
    }

    updateJob(55, "전사된 텍스트를 고도 분석하여 주요 안건, 결정사항 및 실행 과제(To-Do)를 도출하고 있습니다...");

    // 2단계: 텍스트 기반 수석 비즈니스 회의록 자동 요약 및 구조화 (비용이 저렴한 텍스트 입력으로 API 호출, 출력 JSON에서 대형 transcript를 제외하여 토큰 절감 및 잘림 붕괴 원천 차단)
    const summaryPrompt = `당신은 IT 프로덕트 개발 및 비즈니스 회의록 분석 전문가입니다. 제공된 회의 전사 스크립트를 정밀 분석하여, 실행 중심의 고도로 구조화된 '수석 비즈니스 회의록'을 생성해 주십시오.

[작성 가이드라인]
1. "title": 회의 주제를 명쾌하게 요약해 낸 회의록 보고서 제목
2. "date": 회의 발생 일자 (YYYY-MM-DD 형식, 전사에서 유추할 수 없다면 오늘 날짜인 ${creationDateStr} 기입)
3. "attendees": 참석자 실명 배열 (전사 기록을 분석하여 매핑)
4. "agenda": 회의 핵심 안건 리스트
5. "discussion": 논의 배경, 발생한 이슈, 한계, 참석자 의견 개진 등의 '상세 맥락'을 상세히 서술한 리스트 (각 항목은 구체적으로 작성)
6. "decision": 최종 합의되거나 결정된 핵심 결론 리스트
7. "todo": 각 담당자가 처리해야 할 실행 아이템 리스트. 각 객체는 다음 필드를 필수 포함해야 합니다:
   - "task": 구체적이고 상세한 할 일 내용
   - "assignee": 담당자 실명 (명확하지 않으면 '미지정')
   - "dueDate": 구체적인 기한 (YYYY-MM-DD 형식 또는 맥락상 유추 일정 기입, 알 수 없으면 'TBD')

반드시 다음 JSON 형식에 정확히 맞춰 순수한 JSON 데이터만 반환하십시오. 앞뒤 설명이나 마크다운 코드 블록 등 JSON이 아닌 문자열은 절대 출력하지 마십시오.`;

    const summaryResponse = await generateContentWithRetry(aiClient, {
      model: "gemini-3.5-flash",
      contents: [
        { text: `회의 전사 스크립트 원본:\n\n${rawTranscript}` },
        summaryPrompt
      ],
      config: {
        maxOutputTokens: 4096,
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
            }
          },
          required: ["title", "date", "attendees", "agenda", "discussion", "decision", "todo"]
        }
      }
    });

    const outputText = summaryResponse.text;
    console.log("[Summarizer] Raw response from Gemini Model:", outputText);

    if (!outputText) {
      throw new Error("Gemini 모델로부터 회의록 요약 분석 결과를 받지 못했습니다.");
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

    // 3단계: 무손실 전사 텍스트와 구조화된 보고서를 병합 (Split-and-Merge의 완성)
    const structuredNotes = {
      title: structuredNotesRaw.title || "AI 회의록 보고서",
      date: structuredNotesRaw.date || creationDateStr || new Date().toISOString().split('T')[0],
      attendees: ensureArray(structuredNotesRaw.attendees),
      agenda: ensureArray(structuredNotesRaw.agenda),
      discussion: ensureArray(structuredNotesRaw.discussion),
      decision: ensureArray(structuredNotesRaw.decision),
      todo: Array.isArray(structuredNotesRaw.todo) ? structuredNotesRaw.todo : [],
      transcript: rawTranscript // 1단계에서 확보한 100% 무손실 전사본 결합
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
