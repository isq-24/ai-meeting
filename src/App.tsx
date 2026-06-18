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
  Loader2, 
  ChevronRight, 
  AlertCircle, 
  Info, 
  Settings, 
  HelpCircle, 
  RefreshCw 
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

  // Recorder and Audio states
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [processingState, setProcessingState] = useState<"idle" | "recording" | "uploading" | "completed" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Result & History States
  const [minutesResult, setMinutesResult] = useState<MeetingMinutes | null>(null);
  const [savedDocUrl, setSavedDocUrl] = useState<string | null>(null);
  const [savedDocId, setSavedDocId] = useState<string | null>(null);
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
    const unsubscribe = initAuth(
      (currentUser, token) => {
        setUser(currentUser);
        setAccessToken(token);
        setIsAuthenticated(true);
        setIsAuthChecking(false);
        fetchHistory(token);
        showToast(`${currentUser.displayName || "사용자"}님, 반갑습니다.`, "info");
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
        headers: {
          Authorization: `Bearer ${token}`
        }
      });
      if (res.ok) {
        const data = await res.json();
        if (data.success) {
          setHistory(data.files || []);
          if (data.folderUrl) {
            setFolderUrl(data.folderUrl);
          }
        } else {
          console.error("Failed to load history:", data.error);
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
        showToast("성공적으로 로그인되었습니다.", "success");
      }
    } catch (err: any) {
      console.error("Login failed:", err);
      showToast("구글 로그인 도중 에러가 발생했습니다.", "error");
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
      showToast("로그아웃 되었습니다.", "info");
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
      
      showToast("녹음이 시작되었습니다.", "info");
    } catch (err) {
      console.error("Microphone access failed:", err);
      setHasMicPermission(false);
      setProcessingState("idle");
      showToast("마이크 오디오 권한을 허용해 주셔야 녹음 기능을 진행하실 수 있습니다.", "error");
    }
  };

  const pauseRecording = () => {
    if (mediaRecorderRef.current && isRecording && !isPaused) {
      mediaRecorderRef.current.pause();
      setIsPaused(true);
      if (timerRef.current) clearInterval(timerRef.current);
      showToast("녹음이 일시 정지되었습니다.", "info");
    }
  };

  const resumeRecording = () => {
    if (mediaRecorderRef.current && isRecording && isPaused) {
      mediaRecorderRef.current.resume();
      setIsPaused(false);
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
      showToast("녹음이 제개되었습니다.", "info");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setIsPaused(false);
      if (timerRef.current) clearInterval(timerRef.current);
      setProcessingState("uploading");
      showToast("녹음이 완료되었습니다. 회의록 작성이 시작됩니다.", "success");
    }
  };

  // Send voice blob file to express server for Gemini API & Google Workspace Sync
  const uploadAudioToServer = async (blob: Blob) => {
    if (!accessToken) {
      showToast("구글 인증 세션이 만료되었습니다. 다시 로그인 하세요.", "error");
      setProcessingState("idle");
      return;
    }

    const formData = new FormData();
    formData.append("audio", blob, "meeting_record.webm");

    try {
      const response = await fetch("/api/meetings/process", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`
        },
        body: formData
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error || "회의록 분석 중 오류가 발생했습니다.");
      }

      const rawData = await response.json();
      if (rawData.success) {
        setMinutesResult(rawData.structuredNotes);
        setSavedDocUrl(rawData.documentUrl);
        setSavedDocId(rawData.documentId);
        setProcessingState("completed");
        showToast("회의록 작성이 완료되었습니다.", "success");
        // Update user document list from Drive
        fetchHistory(accessToken);
      } else {
        throw new Error(rawData.error || "회의록 구조화 실패");
      }
    } catch (err: any) {
      console.error("Upload error:", err);
      setErrorMessage(err.message || "서버 통신 오류가 발생했습니다.");
      setProcessingState("error");
      showToast("회의록 도출에 실패했습니다. 다시 녹음을 시작해 가동하세요.", "error");
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
              <h1 className="text-xl font-bold tracking-tight text-indigo-900 leading-tight">AI Minute<span className="text-indigo-500">.</span></h1>
              <p className="text-[10px] text-indigo-400 font-bold uppercase tracking-widest hidden sm:block">Automated Sync Workspace</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            <nav className="flex space-x-1">
              <button 
                onClick={() => setActiveTab("app")}
                className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide transition-all duration-200 cursor-pointer ${
                  activeTab === "app" ? "bg-indigo-600 text-white shadow-md shadow-indigo-200" : "text-indigo-700 hover:text-indigo-950 hover:bg-indigo-50"
                }`}
              >
                서비스 바로가기
              </button>
              <button 
                onClick={() => setActiveTab("guide")}
                className={`px-4 py-2 rounded-xl text-xs font-bold uppercase tracking-wide transition-all duration-200 cursor-pointer ${
                  activeTab === "guide" ? "bg-indigo-600 text-white shadow-md shadow-indigo-200" : "text-indigo-700 hover:text-indigo-950 hover:bg-indigo-50"
                }`}
              >
                GCP 설정 가이드
              </button>
            </nav>

            {isAuthenticated && user && (
              <div className="flex items-center gap-3 bg-indigo-50/70 px-3 py-1.5 rounded-2xl border border-indigo-100">
                {user.photoURL ? (
                  <img src={user.photoURL} alt="Profile" className="w-7 h-7 rounded-full border border-white referrerPolicy='no-referrer'" />
                ) : (
                  <div className="w-7 h-7 bg-indigo-600 text-white rounded-full flex items-center justify-center text-xs font-semibold">
                    <User className="w-4 h-4" />
                  </div>
                )}
                <div className="text-left text-xs hidden md:block">
                  <p className="font-bold text-indigo-950 leading-none">{user.displayName || "사용자"}</p>
                  <p className="text-[10px] text-indigo-500 leading-none mt-0.5">{user.email}</p>
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
            <p className="text-slate-500 text-sm mt-4">사용자 로그인 확인 중입니다...</p>
          </div>
        ) : activeTab === "guide" ? (
          /* Google Cloud Platform Setup Guide Panel */
          <motion.div 
            initial={{ opacity: 0, y: 15 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-2xl shadow-sm border border-slate-200/85 p-6 md:p-8"
          >
            <div className="flex items-center gap-3 border-b border-slate-100 pb-5 mb-6">
              <div className="p-2 py bg-emerald-50 text-emerald-600 rounded-xl">
                <Settings className="w-6 h-6" />
              </div>
              <div>
                <h2 className="text-xl font-bold text-slate-900">Google Cloud Platform 및 API 키 설정 가이드</h2>
                <p className="text-sm text-slate-500">본 서비스의 완벽한 작동을 위해 다음의 인프라와 권한을 확인해 주세요.</p>
              </div>
            </div>

            <div className="space-y-6 text-slate-700">
              <section className="bg-slate-50 rounded-xl p-5 border border-slate-200/60">
                <h3 className="font-semibold text-slate-900 text-base mb-3 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-slate-900 text-white text-xs flex items-center justify-center">1</span>
                  Gemini API 키 입력 및 설정 방법
                </h3>
                <p className="text-sm text-slate-600 leading-relaxed mb-3">
                  회의 음성을 텍스트로 똑똑하게 받아 적고 안건, 결정사항, 향후 할 일 등으로 정밀 추출하기 위해 <strong>Gemini 3.5 Flash</strong> 모델을 운용합니다.
                </p>
                <div className="bg-slate-900 text-slate-100 rounded-lg p-3.5 font-mono text-xs overflow-x-auto space-y-1">
                  <p className="text-emerald-400"># AI Studio UI의 Secrets 패널에서 세팅 가능합니다.</p>
                  <p>GEMINI_API_KEY="AIzaSyYourOwnRealAPIKeyHere"</p>
                </div>
              </section>

              <section className="bg-slate-50 rounded-xl p-5 border border-slate-200/60">
                <h3 className="font-semibold text-slate-900 text-base mb-3 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-slate-900 text-white text-xs flex items-center justify-center">2</span>
                  구글 워크스페이스 OAuth 원리 및 폴더 생성
                </h3>
                <p className="text-sm text-slate-600 leading-relaxed mb-3">
                  이 어플리케이션은 사용자가 구글 계정으로 로그인하는 순간 발급되는 <strong>Access Token</strong>을 임시 활용하여 사용자의 드라이브에 접근합니다.
                </p>
                <ul className="list-disc pl-5 text-sm text-slate-600 space-y-1.5">
                  <li><strong>가입 권한 및 스코프 (Scopes)</strong>: <code>drive.file</code>과 <code>documents</code> 권한만을 신뢰하여 작동합니다. 이는 우리 앱이 생성한 회의록 파일 및 폴더에만 가동 제한되는 안전 스코프입니다.</li>
                  <li><strong>특정 폴더 저장 기능</strong>: 회의록을 제출하면, 우선 구글 드라이브 내에 <strong className="text-slate-800">"AI 회의록 자동화"</strong> 폴더를 고유하게 탐색하여 자동 개설하고 모든 완성된 구글 문서들을 그 내부에 자동으로 동화해 차곡차곡 쌓아나갑니다.</li>
                </ul>
              </section>

              <section className="bg-slate-50 rounded-xl p-5 border border-slate-200/60">
                <h3 className="font-semibold text-slate-900 text-base mb-3 flex items-center gap-2">
                  <span className="w-5 h-5 rounded-full bg-slate-900 text-white text-xs flex items-center justify-center">3</span>
                  마이크 하드웨어 장치 권한 허용
                </h3>
                <p className="text-sm text-slate-600 leading-relaxed">
                  브라우저 녹음을 진행하기 위해서 <strong>마이크 허용 권한</strong>이 절대적으로 필요합니다. 브라우저 주소창 왼족의 자물쇠 기호를 눌러, 마이크 액세스 권한이 활성으로 채택되었는지 확인해 주시기 바랍니다. 만일 iFrame 차단에 막힐 경우 상단 설정 메뉴의 <strong>Open in New Tab</strong> 버튼을 눌러 새 탭에서 열어 수행하시면 아주 완벽히 가동됩니다.
                </p>
              </section>
            </div>
            
            <div className="mt-6 flex justify-end">
              <button 
                onClick={() => setActiveTab("app")}
                className="px-5 py-2.5 bg-slate-900 text-white rounded-xl text-sm font-semibold hover:bg-slate-800 transition shadow hover:shadow-md cursor-pointer"
              >
                가이드 확인완료, 서비스로 돌아가기
              </button>
            </div>
          </motion.div>
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
              <h2 className="text-xl font-bold text-slate-900 tracking-tight">구글 연동 로그인 필요</h2>
              <p className="text-sm text-slate-500 mt-2 mb-6 leading-relaxed">
                회의를 녹음하여 텍스트 분석에 도달하고, 생성된 완벽한 회의록을 고객님의 Google Drive 계정에 고도로 정제된 구글 문서로 저장하기 위해서 안전한 구글 로그인이 동반되어야 합니다.
              </p>

              <div className="bg-slate-50 rounded-xl p-4 text-left border border-slate-200/60 mb-6 space-y-2">
                <p className="text-xs text-slate-700 font-semibold flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500"></span>
                  본 프로젝트를 통해 활용되는 필수 전송 기밀 정보:
                </p>
                <p className="text-xs text-slate-500 leading-normal pl-3">
                  • <strong>Google Drive file access</strong>: 파일 및 "AI 회의록 자동화" 폴더 신설 후 문서 관리 용도에 한정.<br />
                  • <strong>Google Docs write</strong>: Gemini를 통해 자동 구성된 보고서 형식 텍스트 기입.
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
                <span>Google 계정으로 로그인</span>
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
                    저장 폴더 바로가기
                  </h2>
                  <span className="inline-flex items-center px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 uppercase tracking-wider">
                    실시간 연동
                  </span>
                </div>
                <p className="text-xs text-slate-500 leading-relaxed mb-4">
                  본 서비스가 생성한 구글 문서(*.gdoc) 파일들은 모두 구글 드라이브 내 <strong>"AI 회의록 자동화"</strong> 폴더 하나에 아주 세밀하고 안전하게 정리됩니다.
                </p>
                <a 
                  href={folderUrl} 
                  target="_blank" 
                  rel="noopener noreferrer"
                  className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-indigo-50 hover:bg-indigo-100 border border-indigo-100 text-indigo-700 hover:text-indigo-800 rounded-2xl text-xs font-bold tracking-wide transition-all duration-200 shadow-sm group cursor-pointer"
                >
                  <FolderOpen className="w-4 h-4 text-indigo-500 group-hover:scale-105 transition" />
                  Google Drive 전용 폴더 바로열기
                </a>
              </motion.div>

              {/* Recording Board with Vibrant Waveform and Large Pulse Action buttons */}
              <motion.div 
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                className="bg-white rounded-[40px] p-6 sm:p-8 flex flex-col justify-between shadow-xl shadow-indigo-150/30 border border-indigo-100/50 relative overflow-hidden"
              >
                <div className="absolute top-6 right-6">
                  {isRecording && !isPaused ? (
                    <span className="px-3.5 py-1 bg-red-100 text-red-600 rounded-full text-[9px] font-bold uppercase tracking-widest animate-pulse">
                      Live Recording
                    </span>
                  ) : (
                    <span className="px-3.5 py-1 bg-indigo-50 text-indigo-600 rounded-full text-[9px] font-bold uppercase tracking-widest font-mono">
                      Ready Stage
                    </span>
                  )}
                </div>

                <div className="text-left mb-6">
                  <h2 className="text-xl font-bold text-indigo-950">프로젝트 세션 레코더</h2>
                  <p className="text-xs text-slate-400 font-medium">실시간 다이어프램 마이크 정밀 수집</p>
                </div>

                {/* Waveform Visualization Animation */}
                <div className="my-6">
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
                          {isPaused ? "⚠️ 녹음 일시 정지됨" : "● 현재 실시간 녹음 중..."}
                        </motion.p>
                      )}
                      {processingState === "uploading" && (
                        <motion.p 
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          exit={{ opacity: 0 }}
                          className="text-xs font-bold text-indigo-600 flex items-center gap-1"
                        >
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-500" />
                          Gemini 3.5 Flash 핵심 회의 분석가 기동 중...
                        </motion.p>
                      )}
                      {processingState === "completed" && (
                        <motion.p 
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className="text-xs font-bold text-emerald-600"
                        >
                          ✓ 회의록 보고서 발행 완료
                        </motion.p>
                      )}
                      {processingState === "error" && (
                        <motion.p 
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          className="text-xs font-bold text-rose-500"
                        >
                          ⚠️ 분석 실패
                        </motion.p>
                      )}
                      {processingState === "idle" && (
                        <p className="text-xs text-slate-400 font-semibold">대기</p>
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
                        회의 녹음 시작
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

                <div className="mt-6 bg-slate-50 p-4 rounded-3xl border border-slate-100 text-[11px] text-slate-500 text-left leading-relaxed flex items-start gap-2.5">
                  <Info className="w-4 h-4 text-indigo-600 shrink-0 mt-0.5" />
                  <span>
                    "회의 완료 및 분석" 시, <strong>Express API 및 Gemini 인프라</strong>가 조율되어 정사 후 구글 드라이브 문서 파일로 완벽하게 신설됩니다.
                  </span>
                </div>
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
                  /* Analyzing State */
                  <motion.div
                    key="analyzing_screen"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="bg-white rounded-[32px] border border-indigo-55 shadow-lg shadow-indigo-150/20 p-10 text-center flex flex-col items-center justify-center min-h-[450px]"
                  >
                    <div className="relative flex items-center justify-center w-20 h-20 mb-6 font-bold">
                      <motion.div 
                        initial={{ rotate: 0 }}
                        animate={{ rotate: 360 }}
                        transition={{ repeat: Infinity, duration: 2, ease: "linear" }}
                        className="w-16 h-16 border-2 border-indigo-600 border-t-transparent rounded-full"
                      />
                      <Sparkles className="w-6 h-6 text-indigo-600 absolute" />
                    </div>
                    <h2 className="text-lg font-bold text-indigo-950 tracking-tight">AI 회의록 분해 및 구조화 분석 중...</h2>
                    <p className="text-xs text-slate-500 mt-2.5 max-w-sm mx-auto leading-relaxed font-medium">
                      구글 드라이브와 문서를 검토하고, 전송을 마친 음성 바이너리 데이터를 바탕으로 <strong>안건, 논의사항, 합의결과 및 액션 플랜(할 일)</strong>을 정교하게 다듬고 있습니다. 잠시만 허용해 주시기 바랍니다.
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
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-[9px] font-bold bg-indigo-500 text-white mb-2 font-mono uppercase tracking-wider">
                          DOCUMENT SYNCHRONIZED
                        </span>
                        <h2 className="text-lg font-bold tracking-tight">{minutesResult.title}</h2>
                        <div className="flex items-center gap-2 mt-1 text-slate-300 text-xs font-semibold">
                          <Calendar className="w-3.5 h-3.5 text-indigo-400" />
                          <span>작성일: {minutesResult.date || new Date().toISOString().split('T')[0]}</span>
                        </div>
                      </div>

                      {savedDocUrl && (
                        <a 
                          href={savedDocUrl} 
                          target="_blank" 
                          rel="noopener noreferrer"
                          className="flex items-center justify-center gap-2 px-4.5 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl text-xs font-bold tracking-wide transition shadow-md shadow-indigo-900/10 cursor-pointer"
                        >
                          <FileText className="w-4 h-4 text-white" />
                          Google Docs 열기
                        </a>
                      )}
                    </div>

                    {/* Report structured details panels */}
                    <div className="p-6 space-y-6">
                      
                      {/* Success Toast Box inside Result */}
                      <div className="bg-emerald-500/10 border border-emerald-500/30 p-4 rounded-2xl flex items-start gap-3">
                        <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                        <div className="text-xs text-emerald-800 text-left">
                          <p className="font-semibold">회의 백서 및 드라이브 문서 구축에 완벽 동기화되었습니다.</p>
                          <p className="mt-1 text-emerald-700/95 font-medium">새문서 ID: <span className="font-mono bg-white px-1.5 py-0.5 rounded border border-emerald-250">{savedDocId}</span></p>
                        </div>
                      </div>

                      {/* 1. Agenda */}
                      <div className="text-left">
                        <h3 className="text-sm font-bold text-indigo-950 flex items-center gap-1.5 border-b border-indigo-50 pb-2 mb-3">
                          <span className="w-1.5 h-3.5 bg-indigo-600 rounded-sm inline-block"></span>
                          안건 (Agenda)
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
                            <li className="text-xs text-slate-400 italic font-medium">감지된 안건이 특별히 표기되지 않았습니다.</li>
                          )}
                        </ul>
                      </div>

                      {/* 2. Discussion */}
                      <div className="text-left">
                        <h3 className="text-sm font-bold text-indigo-950 flex items-center gap-1.5 border-b border-indigo-50 pb-2 mb-3">
                          <span className="w-1.5 h-3.5 bg-indigo-600 rounded-sm inline-block"></span>
                          중요 논의사항 (Discussion)
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
                            <li className="text-xs text-slate-400 italic font-medium">논의 내용 정보 분석이 비어있습니다.</li>
                          )}
                        </ul>
                      </div>

                      {/* 3. Decision */}
                      <div className="text-left">
                        <h3 className="text-sm font-bold text-indigo-950 flex items-center gap-1.5 border-b border-indigo-50 pb-2 mb-3">
                          <span className="w-1.5 h-3.5 bg-indigo-600 rounded-sm inline-block"></span>
                          합의 및 결정사항 (Decision)
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
                            <p className="text-xs text-slate-400 italic">금번 회의에서 기록 조서된 특별 결정사항이 없습니다.</p>
                          )}
                        </div>
                      </div>

                      {/* 4. Todo */}
                      <div className="text-left">
                        <h3 className="text-sm font-bold text-indigo-950 flex items-center gap-1.5 border-b border-indigo-50 pb-2 mb-4">
                          <span className="w-1.5 h-3.5 bg-indigo-600 rounded-sm inline-block"></span>
                          향후 구성원별 할 일 (Action Items)
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
                          <p className="text-xs text-slate-400 italic font-medium pl-1.5">정규화된 추가 후속 업무 스케줄이 부재합니다.</p>
                        )}
                      </div>

                    </div>
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
                    <h3 className="text-md font-bold text-indigo-950">회의 분석 관제 대기</h3>
                    <p className="text-xs text-slate-400 mt-2.5 max-w-sm leading-relaxed font-semibold">
                      좌측 마이크 제어 장치에서 <strong>'회의 녹음 시작'</strong>을 누른 후 가볍게 대화를 나누어보세요. 오디오 전사 후 고도로 다각적이고 입체적인 <strong>AI 보고서 및 회의록</strong>을 생성해 드립니다.
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

          </div>
        )}

      </main>

      {/* Footer Status Bar matching Vibrant Palette */}
      <footer className="mt-12 mb-6 max-w-7xl w-full mx-auto px-4 sm:px-6 lg:px-8 flex justify-between items-center text-[10px] font-bold uppercase tracking-[0.2em] text-indigo-400 flex-wrap gap-4 pt-6 border-t border-indigo-100/40">
        <div className="flex gap-6 flex-wrap font-bold">
          <span>STORAGE: AUTOSYNC RUNNING</span>
          <span>REGION: ASIA-NORTHEAST1</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse"></div>
          <span>ALL PLATFORM SERVICES RUNNING</span>
        </div>
      </footer>

    </div>
  );
}
