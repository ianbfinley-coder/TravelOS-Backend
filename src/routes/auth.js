import express from 'express';
import { verifyFirebaseToken } from '../config/firebase-admin.js';
import { verifyFirebaseAuth } from '../middleware/firebase-auth.js';
import crypto from 'crypto';

const router = express.Router();

/**
 * POST /api/auth/firebase-login
 * Authenticate user with Firebase ID token
 *
 * Request body:
 * {
 *   "idToken": "firebase-id-token"
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "user": {
 *     "uid": "firebase-uid",
 *     "email": "user@example.com",
 *     "displayName": "User Name",
 *     "photoURL": "https://...",
 *     "emailVerified": true
 *   },
 *   "sessionToken": "session-token",
 *   "expiresIn": 3600
 * }
 */
router.post('/firebase-login', async (req, res) => {
  try {
    const { idToken } = req.body;

    if (!idToken) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'idToken is required',
      });
    }

    // Verify Firebase ID token
    const userClaims = await verifyFirebaseToken(idToken);

    // Get Supabase client
    const supabase = req.app.locals.supabase;
    const redis = req.app.locals.redis;

    // Create or update user in Supabase
    let userData = null;
    if (supabase) {
      try {
        // Check if user exists
        const { data: existingUser, error: selectError } = await supabase
          .from('users')
          .select('*')
          .eq('firebase_uid', userClaims.uid)
          .single();

        if (!selectError && existingUser) {
          // Update existing user
          const { data, error } = await supabase
            .from('users')
            .update({
              email: userClaims.email,
              display_name: userClaims.displayName,
              photo_url: userClaims.photoURL,
              last_login: new Date().toISOString(),
            })
            .eq('firebase_uid', userClaims.uid)
            .select()
            .single();

          if (error) throw error;
          userData = data;
        } else {
          // Create new user
          const { data, error } = await supabase
            .from('users')
            .insert({
              firebase_uid: userClaims.uid,
              email: userClaims.email,
              display_name: userClaims.displayName,
              photo_url: userClaims.photoURL,
              email_verified: userClaims.emailVerified,
              created_at: new Date().toISOString(),
              last_login: new Date().toISOString(),
            })
            .select()
            .single();

          if (error) throw error;
          userData = data;
        }

        console.log(`✅ User ${userClaims.email} authenticated and synced to Supabase`);
      } catch (dbError) {
        console.warn('⚠️  Database sync failed:', dbError.message);
        console.warn('   Continuing with authentication without database sync');
      }
    }

    // Generate session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const expiresIn = 3600; // 1 hour
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    // Store session token in Redis for validation (if Redis available)
    if (redis) {
      try {
        const sessionData = {
          uid: userClaims.uid,
          email: userClaims.email,
          displayName: userClaims.displayName,
          issuedAt: new Date().toISOString(),
        };

        await redis.setex(
          `session:${sessionToken}`,
          expiresIn,
          JSON.stringify(sessionData)
        );

        console.log(`✅ Session token stored in Redis for ${userClaims.email}`);
      } catch (cacheError) {
        console.warn('⚠️  Redis cache failed:', cacheError.message);
      }
    }

    // Return success response
    return res.status(200).json({
      success: true,
      user: {
        uid: userClaims.uid,
        email: userClaims.email,
        displayName: userClaims.displayName,
        photoURL: userClaims.photoURL,
        emailVerified: userClaims.emailVerified,
        databaseId: userData?.id,
      },
      sessionToken,
      expiresIn,
      expiresAt,
    });
  } catch (error) {
    console.error('Firebase login error:', error.message);

    return res.status(401).json({
      success: false,
      error: 'Authentication Failed',
      message: error.message,
    });
  }
});

/**
 * GET /api/auth/me
 * Get current authenticated user (requires valid session token or Firebase token)
 */
router.get('/me', verifyFirebaseAuth, (req, res) => {
  return res.status(200).json({
    success: true,
    user: req.user,
  });
});

/**
 * POST /api/auth/logout
 * Invalidate session token
 */
router.post('/logout', async (req, res) => {
  try {
    const { sessionToken } = req.body;

    if (!sessionToken) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'sessionToken is required',
      });
    }

    const redis = req.app.locals.redis;

    // Delete session from Redis
    if (redis) {
      await redis.del(`session:${sessionToken}`);
      console.log('✅ Session token invalidated');
    }

    return res.status(200).json({
      success: true,
      message: 'Logged out successfully',
    });
  } catch (error) {
    console.error('Logout error:', error.message);

    return res.status(500).json({
      error: 'Server Error',
      message: error.message,
    });
  }
});

export default router;
