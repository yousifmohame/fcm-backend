// server.js (أو main.js / index.js)

const express = require('express');
const bodyParser = require('body-parser'); // لتحليل جسم الطلب كـ JSON
const admin = require('firebase-admin');

const app = express();
const port = process.env.PORT || 3000; // Railway ستقوم بتعيين PORT تلقائياً

// --- تهيئة Firebase Admin SDK ---
// تأكد من أن متغيرات البيئة هذه تم ضبطها في إعدادات خدمة Railway
// FIREBASE_SERVICE_ACCOUNT_JSON: سلسلة JSON كاملة لمفتاح حساب الخدمة
// FIREBASE_PROJECT_ID: معرف مشروع Firebase الخاص بك
let firebaseAdminInitialized = false;

function initializeFirebaseAdmin() {
  if (!firebaseAdminInitialized) {
    try {
      const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      const projectId = process.env.FIREBASE_PROJECT_ID;

      if (!serviceAccountString) {
        console.error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set.");
        // لا تقم بتهيئة التطبيق إذا لم يكن المفتاح موجوداً
        return;
      }
      // لا حاجة لـ projectId إذا كان موجوداً داخل serviceAccountString
      // ولكن يمكن إضافته كـ projectId: projectId إذا أردت

      const serviceAccount = JSON.parse(serviceAccountString);

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      firebaseAdminInitialized = true;
      console.log("Firebase Admin SDK initialized successfully.");
    } catch (error) {
      console.error("CRITICAL: Error initializing Firebase Admin SDK:", error.message, error.stack);
      // قد ترغب في إيقاف الخادم أو تسجيل خطأ فادح هنا
    }
  }
}

initializeFirebaseAdmin(); // قم بالتهيئة عند بدء تشغيل الخادم

// Middleware لتحليل JSON bodies
app.use(bodyParser.json());

// --- نقطة النهاية (Endpoint) لإرسال الإشعارات ---
app.post('/send-fcm', async (req, res) => {
  if (!firebaseAdminInitialized) {
    console.error("Firebase Admin SDK not initialized. Cannot send notification.");
    return res.status(500).json({ success: false, error: "Server configuration error." });
  }

  try {
    const { targetUserId, title, body, data = {} } = req.body;

    console.log(`Received request to notify user: ${targetUserId} with title: "${title}"`);

    if (!targetUserId || !title || !body) {
      console.warn("Missing required fields for FCM: targetUserId, title, or body.");
      return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    const userDocRef = admin.firestore().collection("users").doc(targetUserId);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      console.warn(`User not found in Firestore: ${targetUserId}`);
      return res.status(404).json({ success: false, error: "User not found." });
    }

    const userData = userDoc.data();
    const fcmTokens = userData.fcmTokens;

    if (!Array.isArray(fcmTokens) || fcmTokens.length === 0) {
      console.warn(`No FCM tokens found for user: ${targetUserId}`);
      return res.status(400).json({ success: false, error: "No FCM tokens found for this user." });
    }

    const validTokens = fcmTokens.filter(token => typeof token === 'string' && token.trim() !== '');
    if (validTokens.length === 0) {
        console.warn(`No VALID FCM tokens found for user after filtering: ${targetUserId}`);
        return res.status(400).json({ success: false, error: "No valid FCM tokens for user." });
    }

    const messagePayload = {
      tokens: validTokens,
      notification: { title, body },
      data: data, // تأكد أن data هو كائن Map<String, String>
      // android: { notification: { sound: 'default', channelId: 'your_channel_id' } },
      // apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    };

    console.log(`Sending FCM message to ${validTokens.length} token(s).`);
    const response = await admin.messaging().sendEachForMulticast(messagePayload);
    console.log(`FCM send response: SuccessCount=${response.successCount}, FailureCount=${response.failureCount}`);

    if (response.failureCount > 0) {
      const tokensToRemove = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.error(`Token failed [${idx}]: ${validTokens[idx]}, Error: ${resp.error?.code} - ${resp.error?.message}`);
          if (resp.error && (resp.error.code === 'messaging/registration-token-not-registered' ||
                             resp.error.code === 'messaging/invalid-registration-token')) {
            tokensToRemove.push(validTokens[idx]);
          }
        }
      });
      if (tokensToRemove.length > 0) {
        console.log(`Attempting to remove ${tokensToRemove.length} invalid tokens from user ${targetUserId}.`);
        await userDocRef.update({ fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokensToRemove) });
        console.log(`Successfully removed invalid tokens.`);
      }
    }

    return res.status(200).json({
      success: true,
      message: `Notification sent. Success: ${response.successCount}, Failures: ${response.failureCount}.`,
    });

  } catch (err) {
    console.error(`Unhandled error in /send-fcm endpoint: ${err.message}`, err.stack);
    return res.status(500).json({ success: false, error: `Internal server error: ${err.message}` });
  }
});

// نقطة نهاية أساسية للتحقق من أن الخادم يعمل
app.get('/', (req, res) => {
  res.send('FCM Notification Server is running!');
});

app.listen(port, () => {
  console.log(`FCM Notification Server listening on port ${port}`);
});
