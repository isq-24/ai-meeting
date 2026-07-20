import { useState, useEffect, useRef } from "react";
import { 
  motion, 
  AnimatePresence 
} from "motion/react";
import { 
  Mic, 
  Square, 
  Pause, 
  Play, 
  CheckCircle2, 
  FolderOpen, 
  FileText, 
  Search, 
  LogOut, 
  Sparkles, 
  History, 
  Calendar, 
  User, 
  Users,
  Loader2, 
  ChevronRight, 
  AlertCircle, 
  Info, 
  Settings, 
  HelpCircle, 
  RefreshCw,
  Download,
  ExternalLink
} from "lucide-react";
import { 
  initAuth, 
  googleSignIn, 
  logout 
} from "./firebase";
import { 
  MeetingMinutes, 
  DriveDocument 
} from "./types";

export default function App() {
  // Authentication & Session States
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [isAuthChecking, setIsAuthChecking] = useState(true);
  const [showCookieWarning, setShowCookieWarning] = useState(false);
  const [isInIframe, setIsInIframe] = useState(false);

  // Recorder and Audio states
  const [inputMode, setInputMode] = useState<"record" | "upload">("record");
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [processingState, setProcessingState] = useState<"idle" | "recording" | "uploading" | "completed" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastAudioBlob, setLastAudioBlob] = useState<Blob | null>(null);
  const [lastUploadedFile, setLastUploadedFile] = useState<File | null>(null);
  const [progressPercentage, setProgressPercentage] = useState(0);
  const [progressMessage, setProgressMessage] = useState("");

  // Result & History States
  const [minutesResult, setMinutesResult] = useState<MeetingMinutes | null>(null);
  const [savedDocUrl, setSavedDocUrl] = useState<string | null>(null);
  const [savedDocId, setSavedDocId] = useState<string | null>(null);
  const [savedAudioUrl, setSavedAudioUrl] = useState<string | null>(null);
  const [history, setHistory] = useState<DriveDocument[]>([]);
  const [folderUrl, setFolderUrl] = useState<string>("https://drive.google.com");
  const [isHistoryLoading, setIsHistoryLoading] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");

  // Guide vs App Tabs
  const [activeTab, setActiveTab] = useState<"app" | "guide">("app");

  // Notification Toast State
  const [toast, setToast] = useState<{ message: string; type: "info" | "success" | "error" | null }>({
    message: "",
    type: null,
  });

  // Microphone permission state
  const [hasMicPermission, setHasMicPermission] = useState<boolean | null>(null);

  // Refs for tracking audio chunks
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<any>(null);
  const pulseAnimRef = useRef<any>(null);

  // Toast utility
  const showToast = (message: string, type: "info" | "success" | "error") => {
    setToast({ message, type });
    setTimeout(() => {
      setToast(prev => (prev.message === message ? { message: "", type: null } : prev));
    }, 4500);
  };

  // Initialize Authentication State on Load
  useEffect(() => {
    setIsInIframe(window.self !== window.top);
    let alreadyWelcomed = false;
    const unsubscribe = initAuth(
      (currentUser, token) => {
        setUser(currentUser);
        setAccessToken(token);
        setIsAuthenticated(true);
        setIsAuthChecking(false);
        fetchHistory(token);
        if (!alreadyWelcomed) {
          showToast(`${currentUser.displayName || "사용자"}님, 반가워요.`, "info");
          alreadyWelcomed = true;
        }
      },
      () => {
        setUser(null);
        setAccessToken(null);
        setIsAuthenticated(false);
        setIsAuthChecking(false);
      }
    );

    // Initial check for microphone permission
    navigator.permissions?.query?.({ name: "microphone" as PermissionName })
      .then((permissionStatus) => {
        setHasMicPermission(permissionStatus.state === "granted");
        permissionStatus.onchange = () => {
          setHasMicPermission(permissionStatus.state === "granted");
        };
      })
      .catch(() => {
        setHasMicPermission(null);
      });

    return () => {
      unsubscribe();
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  // Fetch created docs from backend linked to User's Drive
  const fetchHistory = async (token: string) => {
    setIsHistoryLoading(true);
    try {
      const res = await fetch("/api/meetings/logs", {
        credentials: "include",
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (res.status === 401) {
        console.warn("Google credentials expired or unauthorized (401). Automatically logging out.");
        await logout();
        setUser(null);
        setAccessToken(null);
        setIsAuthenticated(false);
        setHistory([]);
        showToast("구글 로그인 세션이 끝났어요. 다시 로그인해주세요.", "error");
        return;
      }
      if (res.ok) {
        const contentType = res.headers.get("content-type");
        if (contentType && contentType.includes("application/json")) {
          const data = await res.json();
          if (data.success) {
            setHistory(data.files || []);
            if (data.folderUrl) {
              setFolderUrl(data.folderUrl);
            }
          } else {
            console.error("Failed to load history:", data.error);
          }
        } else {
          const text = await res.text();
          console.error("Non-JSON response received on logs:", text);
          if (text.includes("Cookie check") || text.includes("Action required to load your app") || text.includes("<!doctype html>")) {
            setShowCookieWarning(true);
          }
        }
      }
    } catch (err) {
      console.error("Error loading account history:", err);
    } finally {
      setIsHistoryLoading(false);
    }
  };

  // Login handler
  const handleLogin = async () => {
    try {
      const result = await googleSignIn();
      if (result) {
        setUser(result.user);
        setAccessToken(result.accessToken);
        setIsAuthenticated(true);
        fetchHistory(result.accessToken);
        showToast("로그인했어요.", "success");
      }
    } catch (err: any) {
      console.error("Login failed:", err);
      showToast("구글 로그인 중에 오류가 생겼어요.", "error");
    }
  };

  // Logout handler
  const handleLogout = async () => {
    try {
      await logout();
      setIsAuthenticated(false);
      setUser(null);
      setAccessToken(null);
      setHistory([]);
      setMinutesResult(null);
      setSavedDocUrl(null);
      setSavedDocId(null);
      setSavedAudioUrl(null);
      showToast("로그아웃했어요.", "info");
    } catch (err) {
      console.error("Logout error:", err);
    }
  };

  // Recording Controls
  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      setHasMicPermission(true);
      audioChunksRef.current = [];
      
      const mediaRecorder = new MediaRecorder(stream, { mimeType: "audio/webm" });
      mediaRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
        stream.getTracks().forEach(track => track.stop());
        
        // Save the blob for retry capabilities
        setLastAudioBlob(blob);
        
        // Trigger automatic backend process
        await uploadAudioToServer(blob);
      };

      mediaRecorder.start();
      setIsRecording(true);
      setIsPaused(false);
      setRecordingTime(0);
      setProcessingState("recording");
      setErrorMessage(null);

      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
      
      showToast("녹음을 시작했어요.", "info");
    } catch (err) {
      console.error("Microphone access failed:", err);
      setHasMicPermission(false);
      setProcessingState("idle");
      showToast("녹음하려면 마이크 권한을 허용해야 해요.", "error");
    }
  };

  const pauseRecording = () => {
    if (mediaRecorderRef.current && isRecording && !isPaused) {
      mediaRecorderRef.current.pause();
      setIsPaused(true);
      if (timerRef.current) clearInterval(timerRef.current);
      showToast("녹음을 잠깐 멈췄어요.", "info");
    }
  };

  const resumeRecording = () => {
    if (mediaRecorderRef.current && isRecording && isPaused) {
      mediaRecorderRef.current.resume();
      setIsPaused(false);
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
      showToast("녹음을 다시 시작했어요.", "info");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setIsPaused(false);
      if (timerRef.current) clearInterval(timerRef.current);
      setProcessingState("uploading");
      showToast("녹음을 완료했어요. 회의록을 만들기 시작할게요.", "success");
    }
  };

  // Send voice blob file to express server for Gemini API & Google Workspace Sync
  const uploadAudioToServer = async (blob: Blob) => {
    if (!accessToken) {
      showToast("구글 인증 세션이 끝났어요. 다시 로그인해주세요.", "error");
      setProcessingState("idle");
      return;
    }

    setProgressPercentage(2);
    setProgressMessage("녹음한 음성을 서버로 보낼 준비를 하고 있어요...");

    try {
      const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
      const totalChunks = Math.ceil(blob.size / CHUNK_SIZE);
      const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

      console.log(`Starting chunked upload of ${blob.size} bytes: ${totalChunks} chunks in total (ID: ${uploadId})`);

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, blob.size);
        const chunkBlob = blob.slice(start, end);

        const formData = new FormData();
        formData.append("chunk", chunkBlob, `chunk_${chunkIndex}`);
        formData.append("chunkIndex", chunkIndex.toString());
        formData.append("totalChunks", totalChunks.toString());
        formData.append("uploadId", uploadId);

        setProgressPercentage(Math.floor(2 + (chunkIndex / totalChunks) * 8));
        setProgressMessage(`대용량 음성 파일을 보내고 있어요... (${chunkIndex + 1}/${totalChunks} 청크)`);

        const chunkRes = await fetch("/api/meetings/upload-chunk", {
          method: "POST",
          credentials: "include",
          headers: {
            Authorization: `Bearer ${accessToken}`
          },
          body: formData
        });

        const chunkContentType = chunkRes.headers.get("content-type");
        if (!chunkContentType || !chunkContentType.includes("application/json")) {
          const errText = await chunkRes.text();
          console.error(`Non-JSON response received for chunk ${chunkIndex}:`, errText);
          if (errText.includes("Cookie check") || errText.includes("Action required to load your app") || errText.includes("<!doctype html>")) {
            setShowCookieWarning(true);
          }
          throw new Error(`보내지 못했어요. 서버가 올바르지 않은 형식으로 응답했어요. (상태 코드: ${chunkRes.status})`);
        }

        if (!chunkRes.ok) {
          const errData = await chunkRes.json();
          throw new Error(errData.error || `보내지 못했어요. (상태 코드: ${chunkRes.status})`);
        }

        const chunkData = await chunkRes.json();
        if (!chunkData.success) {
          throw new Error(chunkData.error || "보내지 못했어요. 파일을 보내는 도중 오류가 생겼어요.");
        }
      }

      setProgressPercentage(10);
      setProgressMessage("음성 파일을 다 보냈어요. AI 분석을 준비하고 있어요...");

      // Final process request with uploadId
      const response = await fetch("/api/meetings/process", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({ uploadId })
      });

      let rawData: any = null;
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        rawData = await response.json();
      } else {
        const errorText = await response.text();
        console.error("Non-JSON response received:", errorText);
        if (errorText.includes("Cookie check") || errorText.includes("Action required to load your app") || errorText.includes("<!doctype html>")) {
          setShowCookieWarning(true);
        }
        throw new Error(`서버에서 올바르지 않은 응답을 받았어요. (상태 코드: ${response.status}) ${errorText.substring(0, 150)}`);
      }

      if (!response.ok) {
        throw new Error(rawData?.error || `회의록 분석을 시작하지 못했어요. (상태 코드: ${response.status})`);
      }

      if (rawData.success && rawData.jobId) {
        const jobId = rawData.jobId;
        setProgressPercentage(12);
        setProgressMessage("회의 분석을 예약했어요. 백그라운드에서 분석을 시작할게요...");

        // Polling function
        const pollStatus = async () => {
          try {
            const statusRes = await fetch(`/api/meetings/status/${jobId}`, {
              credentials: "include"
            });
            if (!statusRes.ok) {
              throw new Error(`분석 상태를 확인하지 못했어요. (상태 코드: ${statusRes.status})`);
            }
            
            const statusContentType = statusRes.headers.get("content-type");
            if (statusContentType && statusContentType.includes("application/json")) {
              const statusData = await statusRes.json();
              if (!statusData.success) {
                throw new Error(statusData.error || "작업 상태를 확인하지 못했어요.");
              }

              const { job } = statusData;
              setProgressPercentage(job.progress);
              setProgressMessage(job.message);

              if (job.status === "completed") {
                const result = job.result;
                setMinutesResult(result.structuredNotes);
                setSavedDocUrl(result.documentUrl);
                setSavedDocId(result.documentId);
                setSavedAudioUrl(result.audioUrl || null);
                setProcessingState("completed");
                showToast("회의록을 다 작성했어요.", "success");
                fetchHistory(accessToken);
              } else if (job.status === "failed") {
                throw new Error(job.error || "회의록 분석을 하지 못했어요.");
              } else {
                // Wait 2.5 seconds and poll again
                setTimeout(pollStatus, 2500);
              }
            } else {
              const statusText = await statusRes.text();
              console.error("Non-JSON status response received:", statusText);
              if (statusText.includes("Cookie check") || statusText.includes("Action required to load your app") || statusText.includes("<!doctype html>")) {
                setShowCookieWarning(true);
              }
              throw new Error("서버에서 올바르지 않은 상태 응답을 받았어요.");
            }
          } catch (pollErr: any) {
            console.error("Polling error:", pollErr);
            setErrorMessage(pollErr.message || "회의록 분석 상태를 확인하는 도중 오류가 생겼어요.");
            setProcessingState("error");
            showToast("회의록을 만들지 못했어요. 다시 시도 버튼을 눌러보세요.", "error");
          }
        };

        // Trigger first poll
        setTimeout(pollStatus, 1500);
      } else {
        throw new Error(rawData.error || "회의록 분석 예약을 하지 못했어요.");
      }
    } catch (err: any) {
      console.error("Upload error:", err);
      setErrorMessage(err.message || "서버와 통신하는 중에 오류가 생겼어요.");
      setProcessingState("error");
      showToast("회의록을 만들지 못했어요. 다시 시도 버튼을 눌러보세요.", "error");
    }
  };

  // File Selection and Upload Handlers
  const handleFileChange = (file: File) => {
    if (!file.type.startsWith("audio/") && !/\.(mp3|wav|m4a|webm|ogg|flac|aac)$/i.test(file.name)) {
      showToast("올바른 음성 파일이 아니에요. MP3, WAV, M4A, WEBM, AAC 파일을 올려주세요.", "error");
      return;
    }
    if (file.size > 100 * 1024 * 1024) {
      showToast("파일이 너무 커요. 100MB 이하인 음성 파일만 올릴 수 있어요.", "error");
      return;
    }
    setLastUploadedFile(file);
    setLastAudioBlob(null); // Clear recorder blob to avoid conflict
    showToast(`${file.name} 파일을 선택했어요.`, "success");
  };

  const uploadExternalFileToServer = async (file: File) => {
    if (!accessToken) {
      showToast("구글 인증 세션이 끝났어요. 다시 로그인해주세요.", "error");
      setProcessingState("idle");
      return;
    }

    setProcessingState("uploading");
    setProgressPercentage(2);
    setProgressMessage("음성 파일을 서버로 보낼 준비를 하고 있어요...");

    try {
      const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;

      console.log(`Starting chunked upload of ${file.name} (${file.size} bytes): ${totalChunks} chunks`);

      for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
        const start = chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const chunkBlob = file.slice(start, end);

        const formData = new FormData();
        formData.append("chunk", chunkBlob, `chunk_${chunkIndex}`);
        formData.append("chunkIndex", chunkIndex.toString());
        formData.append("totalChunks", totalChunks.toString());
        formData.append("uploadId", uploadId);

        setProgressPercentage(Math.floor(2 + (chunkIndex / totalChunks) * 8));
        setProgressMessage(`대용량 음성 파일을 보내고 있어요... (${chunkIndex + 1}/${totalChunks} 청크)`);

        const chunkRes = await fetch("/api/meetings/upload-chunk", {
          method: "POST",
          credentials: "include",
          headers: {
            Authorization: `Bearer ${accessToken}`
          },
          body: formData
        });

        const chunkContentType = chunkRes.headers.get("content-type");
        if (!chunkContentType || !chunkContentType.includes("application/json")) {
          const errText = await chunkRes.text();
          throw new Error(`보내지 못했어요. 서버 응답 오류가 생겼어요.`);
        }

        if (!chunkRes.ok) {
          const errData = await chunkRes.json();
          throw new Error(errData.error || `보내지 못했어요. (상태 코드: ${chunkRes.status})`);
        }

        const chunkData = await chunkRes.json();
        if (!chunkData.success) {
          throw new Error(chunkData.error || "보내지 못했어요. 파일을 보내는 중에 오류가 생겼어요.");
        }
      }

      setProgressPercentage(10);
      setProgressMessage("음성 파일을 다 보냈어요. AI 분석을 준비하고 있어요...");

      // Final process request with uploadId, mimeType, and fileName
      const response = await fetch("/api/meetings/process", {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`
        },
        body: JSON.stringify({ 
          uploadId,
          mimeType: file.type || "audio/webm",
          fileName: file.name
        })
      });

      let rawData: any = null;
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        rawData = await response.json();
      } else {
        const errorText = await response.text();
        throw new Error(`서버에서 올바르지 않은 응답을 받았어요. (상태 코드: ${response.status})`);
      }

      if (!response.ok) {
        throw new Error(rawData?.error || `회의록 분석을 시작하지 못했어요.`);
      }

      if (rawData.success && rawData.jobId) {
        const jobId = rawData.jobId;
        setProgressPercentage(12);
        setProgressMessage("회의 분석을 예약했어요. 백그라운드에서 분석을 시작할게요...");

        // Polling function
        const pollStatus = async () => {
          try {
            const statusRes = await fetch(`/api/meetings/status/${jobId}`, {
              credentials: "include"
            });
            if (!statusRes.ok) {
              throw new Error(`분석 상태를 확인하지 못했어요. (상태 코드: ${statusRes.status})`);
            }
            
            const statusData = await statusRes.json();
            if (!statusData.success) {
              throw new Error(statusData.error || "작업 상태를 확인하지 못했어요.");
            }

            const { job } = statusData;
            setProgressPercentage(job.progress);
            setProgressMessage(job.message);

            if (job.status === "completed") {
              const result = job.result;
              setMinutesResult(result.structuredNotes);
              setSavedDocUrl(result.documentUrl);
              setSavedDocId(result.documentId);
              setSavedAudioUrl(result.audioUrl || null);
              setProcessingState("completed");
              showToast("회의록을 다 작성했어요.", "success");
              fetchHistory(accessToken);
            } else if (job.status === "failed") {
              throw new Error(job.error || "회의록 분석을 하지 못했어요.");
            } else {
              // Wait 2.5 seconds and poll again
              setTimeout(pollStatus, 2500);
            }
          } catch (pollErr: any) {
            console.error("Polling error:", pollErr);
            setErrorMessage(pollErr.message || "회의록 분석 상태를 확인하는 도중 오류가 생겼어요.");
            setProcessingState("error");
            showToast("회의록을 만들지 못했어요. 다시 시도 버튼을 눌러보세요.", "error");
          }
        };

        // Trigger first poll
        setTimeout(pollStatus, 1500);
      } else {
        throw new Error(rawData.error || "회의록 분석 예약을 하지 못했어요.");
      }
    } catch (err: any) {
      console.error("Upload error:", err);
      setErrorMessage(err.message || "서버와 통신하는 중에 오류가 생겼어요.");
      setProcessingState("error");
      showToast("회의록을 만들지 못했어요. 다시 시도 버튼을 눌러보세요.", "error");
    }
  };

  // Retry the upload with the last recorded audio blob or last uploaded file
  const handleRetryUpload = async () => {
    if (lastUploadedFile) {
      setProcessingState("uploading");
      setErrorMessage(null);
      showToast("회의록 분석을 다시 시도할게요.", "info");
      await uploadExternalFileToServer(lastUploadedFile);
    } else if (lastAudioBlob) {
      setProcessingState("uploading");
      setErrorMessage(null);
      showToast("회의록을 다시 만들게요.", "info");
      await uploadAudioToServer(lastAudioBlob);
    } else {
      showToast("다시 시도할 음성 파일이 없어요.", "error");
    }
  };

  // Download the last recorded audio blob or uploaded file as backup
  const downloadBackupAudio = () => {
    if (lastUploadedFile) {
      const url = URL.createObjectURL(lastUploadedFile);
      const a = document.createElement("a");
      a.href = url;
      a.download = lastUploadedFile.name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast("음성 파일 백업 저장을 시작했어요.", "success");
    } else if (lastAudioBlob) {
      const url = URL.createObjectURL(lastAudioBlob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `meeting_recording_backup_${Date.now()}.webm`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast("회의 음성 파일 백업 저장을 시작했어요.", "success");
    } else {
      showToast("다운로드할 백업용 음성 파일이 없어요.", "error");
    }
  };

  // Render record elapsed time in format MM:SS
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  // Dynamic filter for history list
  const filteredHistory = history.filter(doc => 
    doc.name.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div id="app_root" className="min-h-screen bg-[#F0F4FF] text-slate-800 font-sans leading-relaxed selection:bg-indigo-150 selection:text-indigo-950 flex flex-col p-2 sm:p-4 md:p-6 overflow-x-hidden">
      
      {/* Iframe Warning Banner */}
      {isInIframe && (
        <div className="w-full max-w-7xl mx-auto mb-4 bg-amber-500/10 border border-amber-500/35 text-amber-900 rounded-[20px] p-4 flex flex-col sm:flex-row items-center justify-between gap-3 shadow-xs">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-amber-600 shrink-0" />
            <div className="text-xs font-semibold text-slate-800 text-left leading-relaxed">
              <strong className="text-amber-950 font-bold text-sm">⚠️ 안전한 이용을 위해 새 창에서 실행해보세요</strong>
              <p className="mt-1 text-slate-600">
                지금 화면에서는 브라우저 보안 설정 때문에 녹음 파일을 올릴 때 오류가 날 수 있어요.<br />
                오류가 생기면 오른쪽 위에 있는 <strong className="text-indigo-600">'새 창으로 열기'</strong> 아이콘이나 아래 버튼을 눌러 새 탭에서 열어보세요. 오류 걱정 없이 이용할 수 있어요!
              </p>
            </div>
          </div>
          <button
            onClick={() => {
              window.open(window.location.href, "_blank");
            }}
            className="shrink-0 flex items-center gap-1.5 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-850 text-white rounded-xl text-xs font-bold transition duration-150 shadow-sm cursor-pointer"
          >
            <ExternalLink className="w-3.5 h-3.5" />
            새 창에서 열기
          </button>
        </div>
      )}

      {/* Toast Alert Portal */}
      <AnimatePresence>
        {toast.message && (
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.95 }}
            className={`fixed top-6 right-6 z-50 flex items-center gap-3 px-5 py-3.5 rounded-2xl shadow-lg border text-sm font-medium backdrop-blur-md max-w-sm ${
              toast.type === "success" 
                ? "bg-emerald-500/10 border-emerald-500/35 text-emerald-800"
                : toast.type === "error"
                ? "bg-rose-500/10 border-rose-500/35 text-rose-800"
                : "bg-slate-900 border-slate-800 text-slate-100"
            }`}
          >
            {toast.type === "success" && <CheckCircle2 className="w-4 h-4 text-emerald-500 shrink-0" />}
            {toast.type === "error" && <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />}
            {toast.type === "info" && <Info className="w-4 h-4 text-emerald-400 shrink-0" />}
            <span>{toast.message}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Iframe Cookie Warning Modal */}
      <AnimatePresence>
        {showCookieWarning && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/60 backdrop-blur-sm">
            <motion.div
              initial={{ opacity: 0, scale: 0.95, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: 10 }}
              className="bg-white rounded-3xl border border-indigo-100 p-6 max-w-md w-full shadow-2xl relative overflow-hidden"
            >
              <div className="flex items-start gap-4 mb-4">
                <div className="p-3 bg-amber-50 rounded-2xl border border-amber-200 text-amber-600">
                  <AlertCircle className="w-6 h-6" />
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-900">쿠키 설정을 확인해주세요</h3>
                  <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">Iframe Cookie Restriction</p>
                </div>
              </div>
              
              <div className="space-y-3 text-sm text-slate-600 mb-6 leading-relaxed text-left">
                <p>
                  지금 브라우저의 보안 정책 때문에 <strong>아이프레임 안에서 쿠키를 사용할 수 없어요.</strong>
                </p>
                <p>
                  이 때문에 구글 로그인이나 서비스가 제대로 작동하지 않을 수 있어요.
                </p>
                <p className="bg-indigo-50/50 p-3 rounded-xl border border-indigo-100 text-xs text-indigo-800 font-medium">
                  💡 <strong>이렇게 해결해보세요:</strong> 오른쪽 위에 있는 <strong>'새 창으로 열기'</strong> 아이콘을 클릭해 직접 앱을 실행하거나, 아래 버튼을 눌러 새 창으로 이동해주세요.
                </p>
              </div>

              <div className="flex gap-3">
                <button
                  onClick={() => {
                    window.open(window.location.href, "_blank");
                  }}
                  className="flex-1 bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 text-white font-semibold text-sm py-3 px-4 rounded-xl transition duration-150 flex items-center justify-center gap-2 shadow-md shadow-indigo-100 cursor-pointer"
                >
                  <Sparkles className="w-4 h-4" />
                  새 창에서 실행하기
                </button>
                <button
                  onClick={() => setShowCookieWarning(false)}
                  className="px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-600 font-semibold text-sm rounded-xl transition duration-150 cursor-pointer"
                >
                  닫기
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Primary Header Navbar in Vibrant Palette */}
      <header className="sticky top-0 z-40 bg-white/80 backdrop-blur-md rounded-[24px] border border-indigo-100/80 text-slate-800 shadow-sm w-full max-w-7xl mx-auto mb-6">
        <div className="px-6 py-4 flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-indigo-600 rounded-xl flex items-center justify-center shadow-md shadow-indigo-100">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-indigo-900 leading-tight">AI Meeting<span className="text-indigo-500">.</span></h1>
              <p className="text-[10px] text-indigo-400 font-bold uppercase tracking-widest hidden sm:block">Automated Sync Workspace</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {isAuthenticated && user && (
              <div className="flex items-center gap-3 bg-indigo-50/70 px-3 py-1.5 rounded-2xl border border-indigo-100">
                {user.photoURL ? (
                  <img src={user.photoURL} alt="Profile" className="w-7 h-7 rounded-full border border-white" referrerPolicy="no-referrer" />
                ) : (
                  <div className="w-7 h-7 bg-indigo-600 text-white rounded-full flex items-center justify-center text-xs font-semibold">
                    <User className="w-4 h-4" />
                  </div>
                )}
                <div className="text-left text-xs hidden md:block">
                  <div className="flex items-center gap-1">
                    <p className="font-bold text-indigo-950 leading-none">{user.displayName || "사용자"}</p>
                    {user.email?.endsWith("@impactsquare.com") ? (
                      <span className="inline-block bg-indigo-600/10 text-indigo-700 text-[9px] font-extrabold px-1.5 py-0.5 rounded-md leading-none border border-indigo-200">corp</span>
                    ) : (
                      <span className="inline-block bg-amber-500/10 text-amber-700 text-[9px] font-extrabold px-1.5 py-0.5 rounded-md leading-none border border-amber-200">test</span>
                    )}
                  </div>
                  <p className="text-[10px] text-indigo-500 leading-none mt-1">{user.email}</p>
                </div>
                <button 
                  onClick={handleLogout}
                  title="로그아웃"
                  className="p-1 hover:text-red-500 text-indigo-600 transition cursor-pointer"
                >
                  <LogOut className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Container */}
      <main className="w-full max-w-7xl mx-auto flex-1">
        
        {isAuthChecking ? (
          <div className="flex flex-col items-center justify-center py-20">
            <Loader2 className="w-10 h-10 text-emerald-500 animate-spin" />
            <p className="text-slate-500 text-sm mt-4">로그인 상태를 확인하고 있어요...</p>
          </div>
        ) : !isAuthenticated ? (
          /* Authentication Screen (Unauthenticated Experience) */
          <div className="max-w-md mx-auto py-12">
            <motion.div 
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8 text-center"
            >
              <div className="w-16 h-16 bg-emerald-500/10 text-emerald-500 rounded-2xl mx-auto flex items-center justify-center mb-6">
                <Mic className="w-8 h-8" />
              </div>
              <h2 className="text-xl font-bold text-slate-900 tracking-tight">구글 계정으로 로그인해주세요</h2>
              <p className="text-sm text-slate-500 mt-2 mb-6 leading-relaxed">
                서비스를 이용하려면 구글 로그인이 필요해요.
              </p>

              {/* Microphone Hardware Permission Guide Highlight */}
              <div className="bg-amber-500/5 border border-amber-500/20 rounded-2xl p-4 md:p-5 text-left text-xs mb-6 space-y-2">
                <p className="font-bold text-amber-950 flex items-center gap-1.5">
                  <Mic className="w-4 h-4 text-amber-600" />
                  🎤 마이크 권한을 허용해주세요
                </p>
                <div className="text-slate-600 leading-relaxed font-medium space-y-1">
                  <p>회의를 녹음하려면 브라우저의 <strong>마이크 권한</strong>을 꼭 허용해야 해요.</p>
                  <p className="pl-1.5 border-l-2 border-amber-500/35 mt-1 text-slate-500">
                    * 설정하는 방법: 브라우저 주소창 왼쪽의 자물쇠 아이콘을 눌러 마이크 권한이 켜져 있는지 확인해주세요.
                  </p>
                  <p className="text-indigo-650 font-bold mt-1">
                    * 만약 화면 오류가 난다면 오른쪽 위 <strong>새 창으로 열기</strong> 버튼을 눌러 새 탭에서 실행해보세요. 아주 잘 작동해요.
                  </p>
                </div>
              </div>

              <div className="bg-slate-50 rounded-xl p-4 text-left border border-slate-200/60 mb-6 space-y-2">
                <p className="text-xs text-indigo-950 font-bold flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-indigo-600"></span>
                  임팩트스퀘어 전용 회의록 서비스
                </p>
                <p className="text-[11px] text-slate-500 leading-normal pl-3">
                  🏢 이 서비스는 <strong>임팩트스퀘어 계정(@impactsquare.com)</strong> 전용으로 맞춤 설계한 AI 회의록 플랫폼이에요. 임팩트스퀘어 계정으로 로그인해주세요.
                </p>
              </div>

              <button
                onClick={handleLogin}
                className="relative flex items-center justify-center gap-3 px-6 py-3 border border-slate-300 hover:border-slate-400 bg-white text-slate-800 font-medium rounded-xl shadow-xs transition-all hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-emerald-500 w-full cursor-pointer"
              >
                <svg viewBox="0 0 24 24" className="w-5 h-5 flex-shrink-0" xmlns="http://www.w3.org/2000/svg">
                  <path fill="#EA4335" d="M12 5.04c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.96 1.19 15.17 0 12 0 7.31 0 3.26 2.69 1.28 6.61l3.99 3.1C6.21 6.82 8.87 5.04 12 5.04z" />
                  <path fill="#4285F4" d="M23.49 12.27c0-.81-.07-1.59-.2-2.36H12v4.51h6.46c-.28 1.48-1.11 2.73-2.36 3.58l3.66 2.84c2.14-1.98 3.39-4.88 3.39-8.57z" />
                  <path fill="#FBBC05" d="M5.27 14.12c-.25-.73-.39-1.5-.39-2.32s.14-1.59.39-2.32L1.28 6.61C.46 8.24 0 10.07 0 12s.46 3.76 1.28 5.39l3.99-3.27z" />
                  <path fill="#34A853" d="M12 24c3.24 0 5.97-1.07 7.96-2.91l-3.66-2.84c-1.01.68-2.31 1.09-3.8 1.09-3.13 0-5.79-1.78-6.73-4.18l-3.99 3.1C3.26 21.31 7.31 24 12 24z" />
                </svg>
                <span>Google 계정으로 로그인하기</span>
              </button>
            </motion.div>
          </div>
        ) : (
          /* Main Authenticated Application View */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            
            {/* Left Column: Drive Folder Shortcuts & Record Controls */}
            <div className="lg:col-span-5 space-y-6">
              
              {/* Quick Drive Folder Connection Shortener Panel */}
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white rounded-[32px] shadow-lg shadow-indigo-150/20 border border-indigo-50/80 p-6"
              >
                <div className="flex items-center justify-between mb-4">
                  <h2 className="text-sm font-bold text-indigo-950 flex items-center gap-1.5">
                    <FolderOpen className="w-4 h-4 text-indigo-600" />
                    저장한 폴더
                  </h2>
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 uppercase tracking-wider">
                    자동 저장 중
                  </span>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed mb-4">
                  여기서 만든 구글 문서와 회의 음성 파일은 모두 구글 드라이브의 <strong>"AI 회의록"</strong> 폴더에 자동으로 저장돼요.
                </p>
                <a 
                  href={folderUrl} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 text-indigo-700 hover:text-indigo-800 rounded-2xl text-xs font-bold tracking-wide transition-all duration-200 shadow-sm group cursor-pointer"
                >
                  <FolderOpen className="w-4 h-4 text-indigo-500 group-hover:scale-105 transition" />
                  구글 드라이브 폴더 열기
                </a>
              </motion.div>

              {/* Recording & Uploading Board with dual-input tab modes */}
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white rounded-[40px] p-6 sm:p-8 flex flex-col justify-between shadow-xl shadow-indigo-150/30 border border-indigo-100/50 relative overflow-hidden"
              >
                <div className="absolute top-6 right-6">
                  {processingState === "recording" && !isPaused ? (
                    <span className="px-3.5 py-1 bg-red-100 text-red-600 rounded-full text-[9px] font-bold uppercase tracking-widest animate-pulse">
                      녹음 중
                    </span>
                  ) : processingState === "uploading" ? (
                    <span className="px-3.5 py-1 bg-indigo-100 text-indigo-600 rounded-full text-[9px] font-bold uppercase tracking-widest animate-pulse">
                      분석 중
                    </span>
                  ) : (
                    <span className="px-3.5 py-1 bg-indigo-50 text-indigo-600 rounded-full text-[9px] font-bold uppercase tracking-widest font-mono">
                      준비 완료
                    </span>
                  )}
                </div>

                <div className="text-left mb-6">
                  <h2 className="text-xl font-bold text-indigo-950">회의록 만들기</h2>
                  <p className="text-xs text-slate-400 font-medium">음성을 분석해 똑똑한 회의록을 만들어요</p>
                </div>

                {/* Mode Switcher */}
                <div className="flex bg-slate-100 p-1 rounded-2xl mb-6 border border-slate-200/40 shrink-0">
                  <button
                    onClick={() => {
                      if (processingState === "recording" || processingState === "uploading") return;
                      setInputMode("record");
                    }}
                    disabled={processingState === "recording" || processingState === "uploading"}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-bold transition-all duration-150 cursor-pointer ${
                      inputMode === "record"
                        ? "bg-white text-indigo-700 shadow-sm border border-slate-200/30 font-extrabold"
                        : "text-slate-500 hover:text-slate-800"
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <Mic className="w-3.5 h-3.5" />
                    실시간 녹음하기
                  </button>
                  <button
                    onClick={() => {
                      if (processingState === "recording" || processingState === "uploading") return;
                      setInputMode("upload");
                    }}
                    disabled={processingState === "recording" || processingState === "uploading"}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-xs font-bold transition-all duration-150 cursor-pointer ${
                      inputMode === "upload"
                        ? "bg-white text-indigo-700 shadow-sm border border-slate-200/30 font-extrabold"
                        : "text-slate-500 hover:text-slate-800"
                    } disabled:opacity-50 disabled:cursor-not-allowed`}
                  >
                    <FolderOpen className="w-3.5 h-3.5" />
                    음성 파일 올리기
                  </button>
                </div>

                {inputMode === "record" ? (
                  /* Real-time Recording Panel */
                  <div className="space-y-6">
                    {/* Waveform Visualization Animation */}
                    <div>
                      <div className="flex items-center justify-center gap-1.5 h-16 bg-gradient-to-tr from-indigo-50/30 to-indigo-50/10 rounded-2xl border border-indigo-50/30 p-4">
                        <div className={`w-1.5 bg-indigo-400 rounded-full transition-all duration-300 ${isRecording && !isPaused ? "h-6 animate-pulse" : "h-2"}`}></div>
                        <div className={`w-1.5 bg-indigo-500 rounded-full transition-all duration-300 ${isRecording && !isPaused ? "h-12 animate-pulse" : "h-3"}`}></div>
                        <div className={`w-1.5 bg-indigo-600 rounded-full transition-all duration-300 ${isRecording && !isPaused ? "h-14 animate-pulse" : "h-1.5"}`}></div>
                        <div className={`w-1.5 bg-indigo-400 rounded-full transition-all duration-300 ${isRecording && !isPaused ? "h-8 animate-pulse" : "h-3"}`}></div>
                        <div className={`w-1.5 bg-indigo-300 rounded-full transition-all duration-300 ${isRecording && !isPaused ? "h-10 animate-pulse" : "h-2"}`}></div>
                        <div className={`w-1.5 bg-indigo-600 rounded-full transition-all duration-300 ${isRecording && !isPaused ? "h-14 animate-pulse" : "h-3.5"}`}></div>
                        <div className={`w-1.5 bg-indigo-500 rounded-full transition-all duration-300 ${isRecording && !isPaused ? "h-11 animate-pulse" : "h-2"}`}></div>
                        <div className={`w-1.5 bg-indigo-400 rounded-full transition-all duration-300 ${isRecording && !isPaused ? "h-6 animate-pulse" : "h-3"}`}></div>
                      </div>
                    </div>

                    <div className="flex flex-col items-center gap-4">
                      {/* Timer Display */}
                      <div className="text-5xl font-mono font-bold text-slate-800 tracking-tighter">
                        {formatTime(recordingTime).split(":")[0]}:<span className="text-indigo-600">{formatTime(recordingTime).split(":")[1]}</span>
                      </div>

                      <div className="h-6">
                        <AnimatePresence mode="wait">
                          {processingState === "recording" && (
                            <motion.p 
                              initial={{ opacity: 0, y: 5 }}
                              animate={{ opacity: 1, y: 0 }}
                              exit={{ opacity: 0 }}
                              className="text-xs font-bold text-indigo-600"
                            >
                              {isPaused ? "⚠️ 녹음을 일시 정지했어요" : "● 지금 실시간으로 녹음하고 있어요"}
                            </motion.p>
                          )}
                          {processingState === "uploading" && (
                            <motion.div 
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              exit={{ opacity: 0 }}
                              className="flex flex-col items-center gap-1.5 w-full max-w-[240px] px-2"
                            >
                              <div className="flex items-center gap-1.5 text-xs font-bold text-indigo-600 text-center justify-center">
                                <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500 shrink-0" />
                                <span>{progressMessage || "분석하고 있어요..."}</span>
                              </div>
                              <div className="w-full bg-indigo-100 rounded-full h-1 overflow-hidden">
                                <div 
                                  className="bg-indigo-600 h-1 rounded-full transition-all duration-300" 
                                  style={{ width: `${progressPercentage}%` }}
                                  id="progress_bar"
                                ></div>
                              </div>
                              <span className="text-[9px] font-mono font-bold text-indigo-400">
                                {progressPercentage}% 진행 중
                              </span>
                            </motion.div>
                          )}
                          {processingState === "completed" && (
                            <motion.p 
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              className="text-xs font-bold text-emerald-600"
                            >
                              ✓ 회의록을 완성했어요
                            </motion.p>
                          )}
                          {processingState === "error" && (
                            <motion.p 
                              initial={{ opacity: 0 }}
                              animate={{ opacity: 1 }}
                              className="text-xs font-bold text-rose-500"
                            >
                              ⚠️ 분석에 실패했어요
                            </motion.p>
                          )}
                          {processingState === "idle" && (
                            <p className="text-xs text-slate-400 font-semibold">준비 완료</p>
                          )}
                        </AnimatePresence>
                      </div>

                      {/* UI Action Control Suite matching design guidelines */}
                      <div className="flex gap-4 justify-center items-center w-full mt-2">
                        {!isRecording ? (
                          <button
                            onClick={startRecording}
                            disabled={processingState === "uploading"}
                            className="w-full py-4 bg-indigo-600 text-white rounded-[24px] font-bold text-sm hover:scale-[1.02] shadow-lg shadow-indigo-150 active:scale-95 transition-all duration-200 flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                          >
                            <Play className="w-4 h-4 fill-white" />
                            녹음 시작하기
                          </button>
                        ) : (
                          <div className="flex items-center gap-4 w-full justify-center">
                            {isPaused ? (
                              <button
                                onClick={resumeRecording}
                                className="w-16 h-16 bg-indigo-600 text-white rounded-[20px] flex items-center justify-center shadow-md shadow-indigo-100/50 hover:scale-105 active:scale-95 transition-transform cursor-pointer"
                                title="다시 재개"
                              >
                                <Play className="w-5 h-5 fill-white text-white" />
                              </button>
                            ) : (
                              <button
                                onClick={pauseRecording}
                                className="w-16 h-16 bg-slate-100 hover:bg-slate-200 text-slate-600 rounded-[20px] flex items-center justify-center border-2 border-slate-50 hover:scale-105 active:scale-95 transition-transform cursor-pointer"
                                title="일시 정지"
                              >
                                <Pause className="w-5 h-5 fill-slate-700 text-slate-750" />
                              </button>
                            )}
                            <button
                              onClick={stopRecording}
                              className="w-20 h-20 bg-red-500 text-white rounded-[28px] flex items-center justify-center shadow-lg shadow-red-200 hover:scale-105 active:scale-95 transition-transform cursor-pointer"
                              title="회의 종료 및 전송 분석"
                            >
                              <Square className="w-7 h-7 fill-white text-white" />
                            </button>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Microphone Hardware Access Assistant for Recorder Panel */}
                    <div className="mt-6 bg-amber-500/5 p-4 rounded-3xl border border-amber-500/20 text-[11px] text-slate-700 text-left leading-relaxed flex items-start gap-2.5">
                      <Mic className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                      <span>
                        <strong>마이크 권한을 확인해주세요</strong>: 회의 음성을 깨끗하게 기록하려면 브라우저의 <strong>마이크 권한</strong>을 허용해야 해요. 주소창 왼쪽 자물쇠 아이콘을 눌러 마이크 권한을 [허용]으로 켜주세요.
                      </span>
                    </div>

                    <div className="mt-4 bg-slate-50 p-4 rounded-3xl border border-slate-100 text-[11px] text-slate-500 text-left leading-relaxed flex items-start gap-2.5">
                      <Info className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
                      <span>
                        "녹음 완료"를 누르면 음성 파일이 구글 드라이브에 저장되고 자동으로 문서 회의록이 만들어져요.
                      </span>
                    </div>
                  </div>
                ) : (
                  /* Audio File Upload Panel with unified Drag & Drop support */
                  <div className="space-y-5">
                    {!lastUploadedFile ? (
                      <div
                        onDragOver={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          const file = e.dataTransfer.files?.[0];
                          if (file) handleFileChange(file);
                        }}
                        onClick={() => {
                          const fileInput = document.getElementById("audio-file-input");
                          fileInput?.click();
                        }}
                        className="border-2 border-dashed border-indigo-200 hover:border-indigo-400 bg-indigo-50/20 hover:bg-indigo-50/45 rounded-3xl p-8 flex flex-col items-center justify-center gap-3 cursor-pointer transition-all duration-200 group min-h-[180px]"
                      >
                        <input
                          type="file"
                          id="audio-file-input"
                          accept="audio/*,.mp3,.wav,.m4a,.webm,.ogg,.flac,.aac"
                          className="hidden"
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleFileChange(file);
                          }}
                        />
                        <div className="w-12 h-12 bg-indigo-100 text-indigo-600 rounded-2xl flex items-center justify-center group-hover:scale-105 transition duration-200 shadow-sm">
                           <FolderOpen className="w-6 h-6 text-indigo-600" />
                        </div>
                        <div className="text-center">
                          <p className="text-xs font-bold text-slate-800">음성 파일 선택하기</p>
                          <p className="text-[10px] text-slate-400 mt-1">이곳에 음성 파일을 끌어다 놓거나 클릭해서 올려주세요</p>
                        </div>
                        <span className="text-[9px] font-mono font-bold bg-indigo-50 text-indigo-600 border border-indigo-100/50 px-2.5 py-0.5 rounded-full uppercase tracking-wider">
                          MP3, WAV, M4A, WEBM, AAC (최대 100MB)
                        </span>
                      </div>
                    ) : (
                      /* Selected Audio File Container card */
                      <div className="bg-indigo-50/30 border border-indigo-100/80 rounded-3xl p-5 flex flex-col gap-4 text-left">
                        <div className="flex items-center gap-3">
                          <div className="w-11 h-11 bg-indigo-100 rounded-2xl flex items-center justify-center text-indigo-600 shrink-0">
                            <FileText className="w-5 h-5 text-indigo-600" />
                          </div>
                          <div className="truncate flex-1">
                            <h4 className="text-xs font-bold text-indigo-950 truncate">{lastUploadedFile.name}</h4>
                            <p className="text-[10px] text-slate-400 font-bold font-mono leading-none mt-1">
                              {(lastUploadedFile.size / (1024 * 1024)).toFixed(2)} MB • {lastUploadedFile.name.split('.').pop()?.toUpperCase() || "AUDIO"}
                            </p>
                          </div>
                          <button
                            onClick={() => {
                              setLastUploadedFile(null);
                              showToast("선택한 파일을 지웠어요.", "info");
                            }}
                            disabled={processingState === "uploading"}
                            className="p-1.5 text-slate-400 hover:text-red-500 hover:bg-slate-100 rounded-lg transition disabled:opacity-50 cursor-pointer"
                            title="파일 해제"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M6 18L18 6M6 6l12 12" />
                            </svg>
                          </button>
                        </div>

                        {processingState === "uploading" && (
                          <div className="flex flex-col gap-1.5 w-full bg-white p-4 rounded-2xl border border-indigo-100/40">
                            <div className="flex items-center gap-1.5 text-xs font-bold text-indigo-600">
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500 shrink-0" />
                              <span>{progressMessage || "보내고 있어요..."}</span>
                            </div>
                            <div className="w-full bg-indigo-100 rounded-full h-1 overflow-hidden mt-1">
                              <div 
                                className="bg-indigo-600 h-1 rounded-full transition-all duration-300" 
                                style={{ width: `${progressPercentage}%` }}
                              ></div>
                            </div>
                            <span className="text-[9px] font-mono font-bold text-indigo-400 self-end mt-0.5">
                              {progressPercentage}% 진행 중
                            </span>
                          </div>
                        )}

                        {processingState !== "uploading" && (
                          <div className="flex gap-3">
                            <button
                              onClick={() => uploadExternalFileToServer(lastUploadedFile)}
                              className="flex-1 py-3.5 bg-indigo-600 text-white rounded-[18px] font-bold text-xs hover:scale-[1.02] shadow-md shadow-indigo-100 active:scale-95 transition-all duration-150 flex items-center justify-center gap-1.5 cursor-pointer"
                            >
                              <Sparkles className="w-3.5 h-3.5 text-indigo-200 animate-pulse" />
                              회의록 AI 분석 시작하기
                            </button>
                          </div>
                        )}
                      </div>
                    )}

                    <div className="bg-slate-50 p-4 rounded-3xl border border-slate-100 text-[11px] text-slate-500 text-left leading-relaxed flex items-start gap-2.5">
                      <Info className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
                      <span>
                        스마트폰 녹음기나 줌(Zoom)에서 저장한 파일도 똑같이 올릴 수 있어요. 분석이 끝나면 구글 드라이브 <strong>"AI 회의록"</strong> 폴더에 원본 음성과 구글 문서 회의록이 함께 안전하게 저장돼요.
                      </span>
                    </div>
                  </div>
                )}
              </motion.div>

              {/* History Search Logs list inside White Beautiful Container */}
              <div className="bg-white rounded-[32px] p-6 shadow-md border border-indigo-50/60 overflow-hidden flex flex-col">
                <div className="flex items-center justify-between mb-4 px-1">
                  <h3 className="text-xs font-bold uppercase tracking-widest text-slate-500 flex items-center gap-1.5">
                    <History className="w-4 h-4 text-indigo-500" />
                    회의 기록 보관소
                  </h3>
                  <button 
                    onClick={() => accessToken && fetchHistory(accessToken)}
                    disabled={isHistoryLoading || !accessToken}
                    className="p-1 hover:bg-slate-50 rounded text-indigo-600 hover:text-indigo-800 transition cursor-pointer"
                    title="기록 목록 동기화"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${isHistoryLoading ? "animate-spin text-indigo-600" : ""}`} />
                  </button>
                </div>

                <div className="relative mb-3.5">
                  <Search className="w-3.5 h-3.5 text-indigo-400 absolute left-3 top-3.5" />
                  <input
                    type="text"
                    placeholder="회의 제목으로 이력 검색..."
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-100 rounded-xl text-xs focus:outline-none focus:ring-1 focus:ring-indigo-500 text-slate-800 placeholder-slate-400"
                  />
                </div>

                <div className="space-y-3.5 max-h-[240px] overflow-y-auto pr-1">
                  {isHistoryLoading ? (
                    <div className="text-center py-6 text-xs text-slate-400 flex flex-col items-center gap-1.5">
                      <Loader2 className="w-4 h-4 animate-spin text-indigo-500" />
                      이전 기록 동기화 중...
                    </div>
                  ) : filteredHistory.length === 0 ? (
                    <p className="text-center py-6 text-xs text-slate-400 leading-normal">
                      {searchTerm ? "검색 결과에 맞는 회의 기록이 부재합니다." : "아직 작성된 회의 보고서가 드라이브 내에 기록되지 않았습니다."}
                    </p>
                  ) : (
                    filteredHistory.map((doc) => (
                      <div
                        key={doc.id}
                        className="p-3.5 rounded-2xl bg-indigo-50/40 border border-indigo-100/30 flex items-center justify-between gap-3 hover:bg-indigo-50 transition"
                      >
                        <div className="flex items-center gap-2.5 truncate max-w-[80%]">
                          <div className="w-9 h-9 bg-indigo-100 rounded-xl flex items-center justify-center shrink-0">
                            <FileText className="w-4 h-4 text-indigo-600" />
                          </div>
                          <div className="truncate text-left">
                            <h4 className="text-xs font-bold text-indigo-950 truncate">{doc.name}</h4>
                            <p className="text-[10px] text-slate-400 font-semibold font-mono leading-none mt-1">
                              {new Date(doc.createdTime).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })}
                            </p>
                          </div>
                        </div>
                        <a 
                          href={doc.webViewLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-indigo-600 font-bold text-xs shrink-0 hover:text-indigo-800 cursor-pointer"
                        >
                          보기
                        </a>
                      </div>
                    ))
                  )}
                </div>
              </div>

            </div>

            {/* Right Column: Actively Generated Minutes Display area */}
            <div className="lg:col-span-7">
              <AnimatePresence mode="wait">
                {processingState === "uploading" ? (
                  /* Analyzing State with Progress Bar */
                  <motion.div
                    key="analyzing_screen"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="bg-white rounded-[32px] border border-indigo-100 shadow-lg shadow-indigo-150/20 p-10 text-center flex flex-col items-center justify-center min-h-[450px] relative overflow-hidden"
                  >
                    {/* Visual glowing bar top accent */}
                    <div className="absolute top-0 left-0 h-1.5 bg-indigo-600 transition-all duration-300" style={{ width: `${progressPercentage}%` }}></div>
                    
                    <div className="relative flex items-center justify-center w-20 h-20 mb-6 font-bold">
                      <motion.div 
                        initial={{ rotate: 0 }}
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                        className="w-16 h-16 border-2 border-indigo-600 border-t-transparent rounded-full"
                      />
                      <Sparkles className="w-6 h-6 text-indigo-600 absolute" />
                    </div>
                    
                    <h2 className="text-lg font-bold text-indigo-950 tracking-tight">
                      {progressMessage || "AI가 회의 내용을 분석하고 있어요..."}
                    </h2>
                    
                    {/* Big progress layout */}
                    <div className="w-full max-w-sm mt-6 mb-2">
                      <div className="w-full bg-indigo-50 border border-indigo-100 rounded-full h-3 overflow-hidden p-0.5">
                        <div 
                          className="bg-indigo-600 h-2 rounded-full transition-all duration-300" 
                          style={{ width: `${progressPercentage}%` }}
                        ></div>
                      </div>
                      <div className="flex justify-between items-center text-[10px] font-bold text-indigo-500 font-mono tracking-wider mt-2 px-1">
                        <span>진행 상황</span>
                        <span>{progressPercentage}% 완료</span>
                      </div>
                    </div>

                    <p className="text-xs text-slate-500 mt-4 max-w-sm mx-auto leading-relaxed font-medium">
                      음성 파일과 구글 드라이브를 확인해 <strong>안건, 논의 내용, 합의 결과, 할 일(액션 플랜)</strong>을 꼼꼼하게 정리하고 있어요. 조금만 기다려주세요.
                    </p>
                  </motion.div>
                ) : processingState === "completed" && minutesResult ? (
                  /* Completed Results View matching design constraints */
                  <motion.div
                    key="summary_result"
                    initial={{ opacity: 0, y: 15 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-white rounded-[32px] border border-indigo-100/50 shadow-lg shadow-indigo-150/20 overflow-hidden"
                  >
                    {/* Header bar */}
                    <div className="p-6 bg-gradient-to-tr from-indigo-900 via-indigo-950 to-slate-900 text-white border-b border-indigo-800 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                      <div className="text-left">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[9px] font-bold bg-indigo-500 text-white mb-2 uppercase tracking-wider">
                          문서 동기화 완료
                        </span>
                        <h2 className="text-lg font-bold tracking-tight">{minutesResult.title}</h2>
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-slate-300 text-xs font-semibold">
                          <div className="flex items-center gap-1.5">
                            <Calendar className="w-3.5 h-3.5 text-indigo-400" />
                            <span>작성일: {minutesResult.date || new Date().toISOString().split('T')[0]}</span>
                          </div>
                          {minutesResult.attendees && minutesResult.attendees.length > 0 && (
                            <div className="flex items-center gap-1.5">
                              <Users className="w-3.5 h-3.5 text-indigo-400" />
                              <span>참석자: {minutesResult.attendees.join(", ")}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex flex-wrap gap-2.5 items-center">
                        {savedAudioUrl && (
                          <a 
                            href={savedAudioUrl} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="flex items-center justify-center gap-2 px-4.5 py-2.5 bg-indigo-50/10 hover:bg-indigo-50/20 text-indigo-200 border border-indigo-500/20 rounded-xl text-xs font-bold tracking-wide transition cursor-pointer"
                          >
                            <Mic className="w-4 h-4 text-indigo-400" />
                            G-Drive 음성 파일 열기
                          </a>
                        )}
                        {savedDocUrl && (
                          <a 
                            href={savedDocUrl} 
                            target="_blank" 
                            rel="noopener noreferrer"
                            className="flex items-center justify-center gap-2 px-4.5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold tracking-wide transition shadow-md shadow-indigo-900/10 cursor-pointer"
                          >
                            <FileText className="w-4 h-4 text-white" />
                            구글 문서 열기
                          </a>
                        )}
                      </div>
                    </div>

                    {/* Report structured details panels */}
                    <div className="p-6 space-y-6">
                      
                      {/* Success Toast Box inside Result */}
                      <div className="bg-emerald-500/10 border border-emerald-500/30 p-4 rounded-2xl flex items-start gap-3">
                        <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                        <div className="text-xs text-emerald-800 text-left">
                          <p className="font-semibold">회의록과 드라이브 문서가 안전하게 저장되었어요.</p>
                          <p className="mt-1 text-emerald-700/95 font-medium">새 문서 ID: <span className="font-mono bg-white px-1.5 py-0.5 rounded border border-emerald-250">{savedDocId}</span></p>
                        </div>
                      </div>

                      {/* 1. Agenda */}
                      <div className="text-left">
                        <h3 className="text-sm font-bold text-indigo-950 flex items-center gap-1.5 border-b border-indigo-50 pb-2 mb-3">
                          <span className="w-1.5 h-3.5 bg-indigo-600 rounded-sm inline-block"></span>
                          1. 회의 안건
                        </h3>
                        <ul className="space-y-2 pl-1.5">
                          {minutesResult.agenda && minutesResult.agenda.length > 0 ? (
                            minutesResult.agenda.map((item, idx) => (
                              <li key={idx} className="text-xs text-slate-600 flex items-start gap-2 font-medium">
                                <span className="text-indigo-500 font-bold shrink-0">•</span>
                                <span>{item}</span>
                              </li>
                            ))
                          ) : (
                            <li className="text-xs text-slate-400 italic font-medium">회의에서 다룬 안건이 없어요.</li>
                          )}
                        </ul>
                      </div>

                      {/* 2. Discussion */}
                      <div className="text-left">
                        <h3 className="text-sm font-bold text-indigo-950 flex items-center gap-1.5 border-b border-indigo-50 pb-2 mb-3">
                          <span className="w-1.5 h-3.5 bg-indigo-600 rounded-sm inline-block"></span>
                          2. 주요 논의사항
                        </h3>
                        <ul className="space-y-2 pl-1.5">
                          {minutesResult.discussion && minutesResult.discussion.length > 0 ? (
                            minutesResult.discussion.map((item, idx) => (
                              <li key={idx} className="text-xs text-slate-600 flex items-start gap-2 leading-relaxed font-medium">
                                <span className="text-indigo-500 font-bold shrink-0">•</span>
                                <span>{item}</span>
                              </li>
                            ))
                          ) : (
                            <li className="text-xs text-slate-400 italic font-medium">회의에서 나눈 논의 내용이 없어요.</li>
                          )}
                        </ul>
                      </div>

                      {/* 3. Decision */}
                      <div className="text-left">
                        <h3 className="text-sm font-bold text-indigo-950 flex items-center gap-1.5 border-b border-indigo-50 pb-2 mb-3">
                          <span className="w-1.5 h-3.5 bg-indigo-600 rounded-sm inline-block"></span>
                          3. 결정사항
                        </h3>
                        <div className="bg-indigo-50/20 border border-indigo-100/60 rounded-2xl p-4 space-y-2.5">
                          {minutesResult.decision && minutesResult.decision.length > 0 ? (
                            minutesResult.decision.map((item, idx) => (
                              <div key={idx} className="text-xs text-slate-700 flex items-start gap-2.5 font-semibold">
                                <span className="w-4.5 h-4.5 rounded-full bg-indigo-100 text-indigo-700 flex items-center justify-center text-[10px] shrink-0 font-bold mt-0.5">
                                  {idx + 1}
                                </span>
                                <span className="leading-relaxed">{item}</span>
                              </div>
                            ))
                          ) : (
                            <p className="text-xs text-slate-400 italic">회의에서 합의된 결정사항이 없어요.</p>
                          )}
                        </div>
                      </div>

                      {/* 4. Todo */}
                      <div className="text-left">
                        <h3 className="text-sm font-bold text-indigo-950 flex items-center gap-1.5 border-b border-indigo-50 pb-2 mb-4">
                          <span className="w-1.5 h-3.5 bg-indigo-600 rounded-sm inline-block"></span>
                          4. 향후 할 일
                        </h3>
                        {minutesResult.todo && minutesResult.todo.length > 0 ? (
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                            {minutesResult.todo.map((item, idx) => (
                              <div key={idx} className="p-3.5 bg-indigo-50/20 border border-indigo-100/40 rounded-2xl space-y-2.5 leading-normal flex flex-col justify-between hover:border-indigo-100 hover:bg-indigo-50/30 transition">
                                <p className="text-xs font-bold text-slate-800 text-left">
                                  {item.task}
                                </p>
                                <div className="flex items-center justify-between text-[10px] text-slate-400 border-t border-indigo-100/20 pt-2 shrink-0">
                                  <span className="flex items-center gap-1 font-bold bg-indigo-100/55 px-2 py-0.5 rounded text-indigo-700">
                                    <User className="w-3 h-3 text-indigo-500" />
                                    {item.assignee || "미지정"}
                                  </span>
                                  <span className="font-mono bg-emerald-50 text-emerald-800 px-1.5 py-0.5 rounded font-bold border border-emerald-100">
                                    기한: {item.dueDate || "없음"}
                                  </span>
                                </div>
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-slate-400 italic font-medium pl-1.5">앞으로 진행할 할 일이 등록되지 않았어요.</p>
                        )}
                      </div>

                      {/* 5. Transcript section */}
                      <div className="text-left">
                        <h3 className="text-sm font-bold text-indigo-950 flex items-center gap-1.5 border-b border-indigo-50 pb-2 mb-4">
                          <span className="w-1.5 h-3.5 bg-indigo-600 rounded-sm inline-block"></span>
                          전사 녹취 스크립트
                        </h3>
                        {minutesResult.transcript ? (
                          <div className="bg-slate-50 border border-slate-100/80 rounded-2xl p-4.5 max-h-[300px] overflow-y-auto whitespace-pre-wrap text-xs text-slate-600 leading-relaxed font-medium font-sans max-w-full">
                            {minutesResult.transcript}
                          </div>
                        ) : (
                          <p className="text-xs text-slate-400 italic font-medium pl-1.5">음성 파일에서 변환된 텍스트가 없어요.</p>
                        )}
                      </div>

                    </div>
                  </motion.div>
                ) : processingState === "error" ? (
                  /* Error State Board with Retry Action */
                  <motion.div
                    key="error_board"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="bg-white rounded-[32px] border border-rose-100 shadow-lg shadow-rose-100/10 p-10 text-center flex flex-col items-center justify-center min-h-[450px]"
                  >
                    <div className="w-20 h-20 bg-rose-50 rounded-[24px] flex items-center justify-center text-rose-500 mb-6 relative">
                      <AlertCircle className="w-10 h-10 text-rose-600" />
                    </div>
                    <h3 className="text-md font-bold text-rose-950">회의록을 만들지 못했어요</h3>
                    <p className="text-xs text-rose-600 font-semibold mt-2.5 max-w-sm leading-relaxed">
                      {errorMessage || "회의 내용을 분석하는 도중 오류가 발생했어요."}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-2.5 max-w-sm leading-relaxed font-medium">
                      네트워크 연결이 일시적으로 불안정하거나, 구글 드라이브 연동에 문제가 생겼을 수 있어요. 다시 한번 시도해보세요.
                    </p>
                    {lastAudioBlob && (
                      <div className="flex flex-col sm:flex-row gap-3 mt-6 w-full justify-center max-w-md">
                        <button
                          onClick={handleRetryUpload}
                          className="flex-1 flex items-center justify-center gap-2 px-5 py-3.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl text-xs font-bold shadow-lg shadow-indigo-150 active:scale-95 transition-all duration-200 cursor-pointer"
                        >
                          <RefreshCw className="w-4 h-4" />
                          다시 시도하기
                        </button>
                        <button
                          onClick={downloadBackupAudio}
                          className="flex-1 flex items-center justify-center gap-2 px-5 py-3.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-2xl text-xs font-bold shadow-lg shadow-emerald-150 active:scale-95 transition-all duration-200 cursor-pointer"
                        >
                          <Download className="w-4 h-4" />
                          녹음 파일 다운로드
                        </button>
                      </div>
                    )}
                  </motion.div>
                ) : (
                  /* Idle state empty board matching design constraints */
                  <motion.div
                    key="idle_board"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="bg-white rounded-[32px] border border-indigo-50/80 shadow-lg shadow-indigo-150/15 p-10 text-center flex flex-col items-center justify-center min-h-[450px]"
                  >
                    <div className="w-20 h-20 bg-indigo-50 rounded-[24px] flex items-center justify-center text-indigo-500 mb-6 relative shadow-inner">
                      <FileText className="w-9 h-9 text-indigo-600" />
                      <Mic className="w-4 h-4 text-indigo-500 absolute bottom-3 right-3 shrink-0" />
                    </div>
                    <h3 className="text-md font-bold text-indigo-950">회의록을 만들 준비가 되었어요</h3>
                    <p className="text-xs text-slate-400 mt-2.5 max-w-sm leading-relaxed font-semibold">
                      왼쪽에서 회의 녹음을 시작하거나 음성 파일을 올려주세요. 회의가 끝나면 AI가 회의록을 자동으로 만들어 드릴게요.
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

          </div>
        )}

      </main>

      {/* Footer matching Vibrant Palette */}
      <footer className="mt-12 mb-6 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center text-[10px] text-slate-400 font-medium pt-6 border-t border-indigo-100/40">
        <div>
          <span>© AI Meeting Minutes Service. All rights reserved.</span>
        </div>
      </footer>

    </div>
  );
}
