import admin from 'firebase-admin';

let firebaseApp = null;

/**
 * Initialize Firebase Admin SDK
 * Requires FIREBASE_ADMIN_SDK_JSON environment variable or GOOGLE_APPLICATION_CREDENTIALS
 */
export const initializeFirebaseAdmin = () => {
  if (firebaseApp) {
    return firebaseApp;
  }

  try {
    const serviceAccountJson = process.env.FIREBASE_ADMIN_SDK_JSON;

    if (!serviceAccountJson) {
      console.warn('⚠️  FIREBASE_ADMIN_SDK_JSON not set. Firebase Admin SDK not initialized.');
      console.warn('   Set FIREBASE_ADMIN_SDK_JSON in .env.local with your Firebase service account JSON');
      return null;
    }

    const serviceAccount = JSON.parse(serviceAccountJson);

    firebaseApp = admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      projectId: serviceAccount.project_id,
    });

    console.log('✅ Firebase Admin SDK initialized');
    return firebaseApp;
  } catch (error) {
    console.error('❌ Failed to initialize Firebase Admin SDK:', error.message);
    return null;
  }
};

/**
 * Verify Firebase ID token
 * @param {string} idToken - Firebase ID token from client
 * @returns {Promise<{uid, email, displayName, photoURL}>} Verified user claims
 */
export const verifyFirebaseToken = async (idToken) => {
  try {
    const firebaseAdmin = initializeFirebaseAdmin();

    if (!firebaseAdmin) {
      throw new Error('Firebase Admin SDK not initialized');
    }

    const decodedToken = await admin.auth().verifyIdToken(idToken);

    return {
      uid: decodedToken.uid,
      email: decodedToken.email,
      displayName: decodedToken.name,
      photoURL: decodedToken.picture,
      emailVerified: decodedToken.email_verified,
    };
  } catch (error) {
    console.error('❌ Token verification failed:', error.message);
    throw new Error(`Invalid Firebase token: ${error.message}`);
  }
};

export default { initializeFirebaseAdmin, verifyFirebaseToken };
