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

// Check for required environment variables
if (!process.env.GEMINI_API_KEY) {
  console.warn("WARNING: GEMINI_API_KEY is not defined in environment variables!");
}

// Helper to retrieve live lazy-loaded GoogleGenAI client
function getAIClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("서버 환경 변수에 GEMINI_API_KEY가 존재하지 않습니다.");
  }
  return new GoogleGenAI({
    apiKey: apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });
}

// Configure standard express parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper function to search or create the Google Drive folder "AI 회의록 자동화"
async function getOrCreateFolder(accessToken: string): Promise<string | null> {
  const folderName = "AI 회의록 자동화";
  try {
    // 1. Search for folder
    const searchUrl = `https://www.googleapis.com/drive/v3/files?q=mimeType='application/vnd.google-apps.folder'+and+name='${encodeURIComponent(folderName)}'+and+trashed=false&fields=files(id)`;
    const searchRes = await fetch(searchUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!searchRes.ok) {
      const errText = await searchRes.text();
      console.error("Failed to search folder in Google Drive:", errText);
      return null;
    }

    const searchData = await searchRes.json();
    if (searchData.files && searchData.files.length > 0) {
      return searchData.files[0].id;
    }

    // 2. Folder not found, create it
    console.log("Folder not found. Creating a new folder in Google Drive...");
    const createRes = await fetch("https://www.googleapis.com/drive/v3/files", {
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
      console.error("Failed to create folder in Google Drive:", errText);
      return null;
    }

    const createData = await createRes.json();
    return createData.id;
  } catch (error) {
    console.error("Error in getOrCreateFolder:", error);
    return null;
  }
}

// -----------------------------------------------------------------
// 1. API - POST /api/meetings/process
// Receives an audio file, transcribes/summarizes via Gemini, 
// and writes the result to Google Docs in Google Drive folder.
// -----------------------------------------------------------------
app.post("/api/meetings/process", upload.single("audio"), async (req: Request, res: Response): Promise<void> => {
  const audioFile = req.file;
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ success: false, error: "구글 로그인 인증 토큰이 필요합니다. (Authorization header missing)" });
    return;
  }

  const accessToken = authHeader.split(" ")[1];

  if (!audioFile) {
    res.status(400).json({ success: false, error: "녹음된 오디오 파일이 전송되지 않았습니다." });
    return;
  }

  // Check if GEMINI_API_KEY variable is supplied on Cloud Run environment
  if (!process.env.GEMINI_API_KEY) {
    res.status(500).json({
      success: false,
      error: "배포된 Google Cloud Run 환경 변수에 GEMINI_API_KEY가 추가되지 않았습니다. Google Cloud Console -> Cloud Run -> 해당 서비스 선택 -> '수정 및 새 버전 배포' 메뉴로 들어가서 환경 변수(Variables) 탭에 GEMINI_API_KEY 항목과 발급받으신 API 키 값을 등록해 주세요."
    });
    return;
  }

  let uploadedGenAIFile: any = null;
  const tempFilePath = audioFile.path;

  try {
    console.log(`Received voice file of size ${audioFile.size} bytes at ${tempFilePath}`);

    // Standard fallback mime mapping if webm audio format
    let mimeType = audioFile.mimetype;
    if (mimeType === "application/octet-stream" || !mimeType) {
      mimeType = "audio/webm";
    }

    const aiClient = getAIClient();
    console.log(`Uploading file ${tempFilePath} to Gemini File API (mime: ${mimeType})...`);
    uploadedGenAIFile = await aiClient.files.upload({
      file: tempFilePath,
      config: {
        mimeType: mimeType,
      }
    });

    console.log(`Gemini File API Upload success. File Name: ${uploadedGenAIFile.name}`);

    // Prepare structure-driven prompt with JSON response requirement
    const systemPrompt = `당신은 핵심 안건과 결정사항을 추려내는 유능한 서기(Secretary)이자 회의록 전문가입니다.
제공된 한국어 음성 파일을 정직하고 명확하게 한글로 전사한 뒤, 다음 필드를 포함하는 완벽한 JSON 형식으로 회의록을 보고서 형태로 도출해 주세요.

한국어로 대답해야 하며, JSON 이외의 설명이나 구분 기호, 코드 블록 마크다운(\`\`\`json ...)은 배제하고 순수한 JSON 데이터만 제공하세요.

객체 필드:
- "title": 회의의 주요 명제 및 주제를 논의 상태에 맞추어 명쾌하게 뽑아낸 보고서 제목
- "date": 회의 발생 일자 (YYYY-MM-DD 기입)
- "agenda": 이번 회의에서 대화의 중심 주제나 회의 대상이 된 안건 리스트
- "discussion": 안건에 대한 참여자들의 중심 주장 및 주요 대화 핵심 내용 요약 리스트
- "decision": 회의 결과 합동 동의하거나 확정된 사항 리스트
- "todo": 향후 각 담당자가 기한 내 처리해야 할 액션 아이템들의 리스트. 각각 "task"(할 일), "assignee"(담당자 이름, 명확하지 않으면 '미지정'), "dueDate"(기한 정보, 명확하지 않으면 '없음')를 한글 정보로 객체화할 것.`;

    const modelResponse = await aiClient.models.generateContent({
      model: "gemini-2.5-flash",
      contents: [
        uploadedGenAIFile,
        systemPrompt
      ],
      config: {
        responseMimeType: "application/json",
      }
    });

    const outputText = modelResponse.text;
    console.log("Raw response from Gemini Model:", outputText);

    if (!outputText) {
      throw new Error("Gemini 모델로부터 응답 텍스트를 받지 못했습니다.");
    }

    // Clean or Parse Gemini response
    let structuredNotes;
    try {
      structuredNotes = JSON.parse(outputText.trim());
    } catch (parseErr) {
      console.warn("JSON direct parse failed. Attempting cleanup...", parseErr);
      // Clean up common markdown block slop if any
      const cleanedText = outputText
        .replace(/```json/gi, "")
        .replace(/```/g, "")
        .trim();
      structuredNotes = JSON.parse(cleanedText);
    }

    console.log("Structured Meeting Minutes prepared successfully:", structuredNotes);

    // Get or Create Drive folder "AI 회의록 자동화"
    const folderId = await getOrCreateFolder(accessToken);
    if (!folderId) {
      console.warn("Google Drive folder retrieval failed. Creating file in Drive root instead.");
    }

    // Create styled Google Doc inside that Folder
    const docTitle = structuredNotes.title || `AI 회의록 - ${new Date().toLocaleDateString('ko-KR')}`;
    console.log(`Creating Google Doc '${docTitle}' inside directory [folderId: ${folderId}]...`);

    const createDocRes = await fetch("https://www.googleapis.com/drive/v3/files", {
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

    const docMetadata = await createDocRes.ok ? await createDocRes.json() : null;
    const documentId = docMetadata?.id;

    if (!documentId) {
      throw new Error("Google Docs 생성 과정에서 파일 ID를 획득하지 못했습니다.");
    }

    // Prepare elegant Docs text
    const formatAgenda = structuredNotes.agenda.map((a: string) => `  • ${a}`).join("\n");
    const formatDiscussion = structuredNotes.discussion.map((d: string) => `  • ${d}`).join("\n");
    const formatDecision = structuredNotes.decision.map((de: string) => `  • ${de}`).join("\n");
    const formatTodo = structuredNotes.todo.map((t: any) => `  • ${t.task} (담당자: ${t.assignee || "미지정"}, 기한: ${t.dueDate || "없음"})`).join("\n");

    const mainReportText = 
      `📝 ${structuredNotes.title || "AI 회의록 자동 생성 보고서"}\n` +
      `📅 회의 일자: ${structuredNotes.date || new Date().toISOString().split('T')[0]}\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `■ 1. 회의 안건 (Agenda)\n` +
      `${formatAgenda || "  - 등록된 안건이 없습니다."}\n\n` +
      `■ 2. 주요 논의사항 (Discussion)\n` +
      `${formatDiscussion || "  - 등록된 논의사항이 없습니다."}\n\n` +
      `■ 3. 결정사항 (Decision)\n` +
      `${formatDecision || "  - 등록된 결정사항이 없습니다."}\n\n` +
      `■ 4. 향후 할 일 및 후속 조치 (Todo Lists)\n` +
      `${formatTodo || "  - 지정된 할 일이 없습니다."}\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `본 회의록은 AI 회의록 자동화 웹 서비스를 통해 음성을 정밀 분석하여 자동 기재되었습니다.`;

    console.log(`Updating Google Doc index [ID: ${documentId}] with styled content...`);
    const updateDocsRes = await fetch(`https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          {
            insertText: {
              text: mainReportText,
              location: { index: 1 }
            }
          }
        ]
      }),
    });

    if (!updateDocsRes.ok) {
      const errText = await updateDocsRes.text();
      console.error("Docs text insertion failed. The empty Doc remains.", errText);
    } else {
      console.log("Docs content batchUpdate successful!");
    }

    // Fetch the true webViewLink of created Google Docs file
    const getFileMeta = await fetch(`https://www.googleapis.com/drive/v3/files/${documentId}?fields=webViewLink`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const fileMetaData = await getFileMeta.json();
    const documentUrl = fileMetaData.webViewLink || `https://docs.google.com/document/d/${documentId}/edit`;

    res.json({
      success: true,
      documentId: documentId,
      documentUrl: documentUrl,
      structuredNotes: structuredNotes,
      transcript: outputText
    });

  } catch (err: any) {
    console.error("Critical error in process API:", err);
    res.status(500).json({
      success: false,
      error: err.message || "회의록 자동 작성을 진행하는 도중 비정상적인 서버 에러가 발생했습니다."
    });
  } finally {
    // 1. Clean up Gemini Remote API File to manage space
    if (uploadedGenAIFile) {
      try {
        console.log(`Deleting file from Gemini File Storage to free up space: ${uploadedGenAIFile.name}`);
        const aiClient = getAIClient();
        await aiClient.files.delete({ name: uploadedGenAIFile.name });
      } catch (cleanUpErr) {
        console.warn("Failed to clean up Gemini Storage File:", cleanUpErr);
      }
    }

    // 2. Clean up locally stored multipart file segment on local filesystem
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
        console.log(`Deleted local temp file successfully: ${tempFilePath}`);
      }
    } catch (fsCleanErr) {
      console.warn("Failed to delete local temp file:", fsCleanErr);
    }
  }
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

    // List docs inside "AI 회의록 자동화" folder
    const listUrl = `https://www.googleapis.com/drive/v3/files?q='${folderId}'+in+parents+and+mimeType='application/vnd.google-apps.document'+and+trashed=false&orderBy=createdTime+desc&fields=files(id,name,webViewLink,createdTime)`;
    const listRes = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });

    if (!listRes.ok) {
      const errText = await listRes.text();
      throw new Error(`Failed to list docs: ${errText}`);
    }

    const listData = await listRes.json();
    const files = listData.files || [];

    // Get folder webViewLink to dynamically navigate user
    const getFolderMeta = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=webViewLink`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    const folderMetaData = await getFolderMeta.json();
    const folderUrl = folderMetaData.webViewLink || `https://drive.google.com/drive/folders/${folderId}`;

    res.json({
      success: true,
      files: files,
      folderUrl: folderUrl
    });

  } catch (error: any) {
    console.error("Failed to query meeting logs from Drive:", error);
    res.status(500).json({ success: false, error: error.message || "이전 기록을 구글 드라이브로부터 동기화하는 도중 에러가 발생했습니다." });
  }
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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running and listening internally on internal port ${PORT}`);
  });
}

startServer();
