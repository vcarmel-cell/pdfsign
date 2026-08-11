// ─── הגדרות (למלא לפי README.md) ────────────────────────────────
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDQu1NS7lkTd4-bLDhYpbTc6HdjqGS7LEs",
  authDomain: "pdfsign-b5230.firebaseapp.com",
  projectId: "pdfsign-b5230",
  storageBucket: "pdfsign-b5230.firebasestorage.app",
  messagingSenderId: "740254268902",
  appId: "1:740254268902:web:abced3a8768487a6ad6a27"
};

const EMAILJS_CONFIG = {
  publicKey: "PASTE_EMAILJS_PUBLIC_KEY",
  serviceId: "PASTE_EMAILJS_SERVICE_ID",
  templateId: "PASTE_EMAILJS_TEMPLATE_ID"
};

const ADMIN_EMAIL = "v.carmel@gmail.com";

// כתובת ה-Cloud Function "detectFields" (זיהוי שדות אוטומטי ב-AI) - מתקבלת
// אחרי `firebase deploy --only functions`, ראו README.md. כל עוד זה נשאר
// PASTE_... הכפתור המתאים ב-admin.html פשוט לא מוצג.
const AI_DETECT_FUNCTION_URL = "PASTE_AI_DETECT_FUNCTION_URL";

// ─── טעינת ספריות חיצוניות (CDN, בזו אחר זו) ─────────────────────
function loadScripts(urls) {
  return new Promise((resolve, reject) => {
    function next(i) {
      if (i >= urls.length) return resolve(true);
      const s = document.createElement('script');
      s.src = urls[i];
      s.onload = () => next(i + 1);
      s.onerror = () => reject(new Error('נכשלה טעינת ' + urls[i]));
      document.head.appendChild(s);
    }
    next(0);
  });
}

// Firebase Storage דורש תוכנית Blaze (בתשלום לפי שימוש) - הפרויקט שודרג
// כדי לתמוך בקבצים גדולים יותר מ-500KB. תבניות/הגשות ישנות שנשמרו כ-Base64
// בתוך Firestore (מלפני השדרוג) ממשיכות לעבוד בלי מיגרציה, ראו getPdfBytes().
const FIREBASE_SDK_URLS = [
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth-compat.js',
  'https://www.gstatic.com/firebasejs/9.22.2/firebase-storage-compat.js'
];

async function fbInit() {
  if (typeof firebase === 'undefined') throw new Error('Firebase SDK לא נטען');
  if (!firebase.apps.length) firebase.initializeApp(FIREBASE_CONFIG);
  return {
    db: firebase.firestore(),
    auth: firebase.auth(),
    storage: firebase.storage()
  };
}

// מריץ פעולת Auth (כמו יצירת משתמש חדש) על אפליקציית Firebase שנייה, זמנית -
// כדי שזה לא יחליף את המשתמש המחובר כרגע (מנהל שיוצר משתמש חדש היה "מתחבר"
// בטעות בתור המשתמש החדש אחרת, כי createUserWithEmailAndPassword מתחבר
// אוטומטית בתור המשתמש שנוצר). אין Cloud Functions/Admin SDK באפליקציה הזו,
// אז זו הדרך התקנית מצד לקוח בלבד ליצור משתמשים חדשים בלי להתנתק בעצמך.
async function withSecondaryAuth(fn) {
  const existing = firebase.apps.find(a => a.name === 'secondary');
  if (existing) await existing.delete();
  const secondaryApp = firebase.initializeApp(FIREBASE_CONFIG, 'secondary');
  try {
    return await fn(secondaryApp.auth());
  } finally {
    await secondaryApp.delete();
  }
}
