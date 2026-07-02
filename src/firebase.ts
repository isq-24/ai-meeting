import { initializeApp } from "firebase/app";
import { 
  initializeAuth,
  browserLocalPersistence,
  browserPopupRedirectResolver,
  signInWithPopup, 
  GoogleAuthProvider, 
  onAuthStateChanged, 
  User 
} from "firebase/auth";
import firebaseConfig from "../firebase-applet-config.json";

// Initialize Firebase using the workspace-provisioned configuration
const app = initializeApp(firebaseConfig);
export const auth = initializeAuth(app, {
  persistence: browserLocalPersistence,
  popupRedirectResolver: browserPopupRedirectResolver,
});

// Configure Google OAuth Provider
export const provider = new GoogleAuthProvider();
// Required scopes for Google Drive and Google Docs
provider.addScope("https://www.googleapis.com/auth/drive.file");
provider.addScope("https://www.googleapis.com/auth/documents");

let isSigningIn = false;
let cachedAccessToken: string | null = null;

// Initialize auth state listener. Call this on app load.
export const initAuth = (
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthFailure?: () => void
) => {
  const token = localStorage.getItem("google_access_token");
  const userJson = localStorage.getItem("google_user_profile");
  const timestampStr = localStorage.getItem("google_token_timestamp");

  let isExpired = false;
  if (timestampStr) {
    const timestamp = parseInt(timestampStr, 10);
    // Google Access Tokens expire after 1 hour (3600 seconds).
    // Use a 5 minute (300 seconds) safety buffer.
    if (isNaN(timestamp) || Date.now() - timestamp > (3600 - 300) * 1000) {
      isExpired = true;
    }
  } else if (token) {
    // If a token exists without a timestamp, treat it as expired to be safe.
    isExpired = true;
  }

  if (isExpired) {
    localStorage.removeItem("google_access_token");
    localStorage.removeItem("google_user_profile");
    localStorage.removeItem("google_token_timestamp");
    cachedAccessToken = null;
    if (onAuthFailure) onAuthFailure();
  } else if (token && userJson) {
    try {
      const cachedUser = JSON.parse(userJson);
      cachedAccessToken = token;
      if (onAuthSuccess) {
        onAuthSuccess(cachedUser as User, token);
      }
    } catch (e) {
      console.error("Failed to parse cached user:", e);
      if (onAuthFailure) onAuthFailure();
    }
  } else {
    if (onAuthFailure) onAuthFailure();
  }

  return onAuthStateChanged(auth, async (user: User | null) => {
    if (user) {
      const profile = {
        uid: user.uid,
        displayName: user.displayName,
        email: user.email,
        photoURL: user.photoURL,
      };
      localStorage.setItem("google_user_profile", JSON.stringify(profile));
      
      const currentToken = cachedAccessToken || localStorage.getItem("google_access_token");
      if (currentToken) {
        cachedAccessToken = currentToken;
        localStorage.setItem("google_access_token", currentToken);
        // Ensure timestamp is preserved/set if we have a valid token
        if (!localStorage.getItem("google_token_timestamp")) {
          localStorage.setItem("google_token_timestamp", Date.now().toString());
        }
        if (onAuthSuccess) onAuthSuccess(user, currentToken);
      } else {
        // If there's no Google Access Token, we cannot query Google APIs, so trigger failure
        if (onAuthFailure) onAuthFailure();
      }
    } else {
      const currentToken = localStorage.getItem("google_access_token");
      const currentUserJson = localStorage.getItem("google_user_profile");
      if (!currentToken || !currentUserJson) {
        if (onAuthFailure) onAuthFailure();
      }
    }
  });
};

// Must be called from a button click or user interaction
export const googleSignIn = async (): Promise<{ user: User; accessToken: string } | null> => {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error("Failed to get access token from Firebase Auth");
    }

    cachedAccessToken = credential.accessToken;
    localStorage.setItem("google_access_token", cachedAccessToken);
    localStorage.setItem("google_token_timestamp", Date.now().toString());
    
    const profile = {
      uid: result.user.uid,
      displayName: result.user.displayName,
      email: result.user.email,
      photoURL: result.user.photoURL,
    };
    localStorage.setItem("google_user_profile", JSON.stringify(profile));

    return { user: result.user, accessToken: cachedAccessToken };
  } catch (error: any) {
    console.error("Sign in error:", error);
    throw error;
  } finally {
    isSigningIn = false;
  }
};

export const getAccessToken = async (): Promise<string | null> => {
  if (!cachedAccessToken) {
    cachedAccessToken = localStorage.getItem("google_access_token");
  }
  return cachedAccessToken;
};

export const logout = async () => {
  await auth.signOut();
  cachedAccessToken = null;
  localStorage.removeItem("google_access_token");
  localStorage.removeItem("google_user_profile");
  localStorage.removeItem("google_token_timestamp");
};
