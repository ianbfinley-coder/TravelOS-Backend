import { verifyFirebaseToken } from '../config/firebase-admin.js';

/**
 * Middleware to verify Firebase ID token
 * Extracts token from Authorization header and verifies it
 */
export const verifyFirebaseAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid Authorization header',
      });
    }

    const idToken = authHeader.substring(7); // Remove 'Bearer ' prefix

    const userClaims = await verifyFirebaseToken(idToken);
    req.user = userClaims;
    next();
  } catch (error) {
    console.error('Firebase auth middleware error:', error.message);
    return res.status(401).json({
      error: 'Unauthorized',
      message: error.message,
    });
  }
};

export default verifyFirebaseAuth;
