// اسم الملف: server.js (أو main.js / index.js حسب إعدادات Railway)

// 1. استيراد الاعتماديات اللازمة
const express = require('express');
const bodyParser = require('body-parser'); // لتحليل جسم الطلب كـ JSON
const admin = require('firebase-admin'); // للتفاعل مع Firebase (Firestore و FCM)

// إنشاء تطبيق Express
const app = express();
// Railway ستقوم بتعيين متغير البيئة PORT تلقائياً. استخدم 3000 كقيمة افتراضية للتطوير المحلي.
const port = process.env.PORT || 3000;

// --- تهيئة Firebase Admin SDK ---
let firebaseAdminInitialized = false;

function initializeFirebaseAdmin() {
  // يتم استدعاء هذه الدالة مرة واحدة فقط
  if (!firebaseAdminInitialized) {
    try {
      // --- متغيرات البيئة المطلوبة في إعدادات خدمة Railway ---
      // FIREBASE_SERVICE_ACCOUNT_JSON: يجب أن يكون سلسلة JSON كاملة لمفتاح حساب خدمة Firebase
      // FIREBASE_PROJECT_ID: معرف مشروع Firebase الخاص بك (يمكن استنتاجه من serviceAccount، لكن تحديده جيد)

      const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
      const projectId = process.env.FIREBASE_PROJECT_ID;

      if (!serviceAccountString) {
        console.error("FATAL ERROR: FIREBASE_SERVICE_ACCOUNT_JSON environment variable is not set.");
        // لا تقم بتهيئة التطبيق إذا لم يكن المفتاح موجوداً
        // قد ترغب في إيقاف الخادم أو تسجيل خطأ فادح هنا
        throw new Error("Firebase service account key JSON string is missing in environment variables.");
      }
      if (!projectId) {
        console.warn("WARNING: FIREBASE_PROJECT_ID environment variable is not set. Attempting to infer from service account.");
        // يمكن لـ SDK استنتاجه، ولكن من الأفضل تحديده
      }

      const serviceAccount = JSON.parse(serviceAccountString);

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: projectId, // تحديد projectId يضمن الاتصال بالمشروع الصحيح
      });

      firebaseAdminInitialized = true;
      console.log("Firebase Admin SDK initialized successfully.");
    } catch (error) {
      console.error("CRITICAL: Error initializing Firebase Admin SDK:", error.message, error.stack);
      // إذا فشلت التهيئة، يجب أن لا تستمر الدالة في محاولة استخدام admin SDK
      // إلقاء الخطأ هنا سيمنع الخادم من البدء بشكل غير صحيح
      throw new Error(`Firebase Admin SDK initialization failed: ${error.message}`);
    }
  }
}

// قم بالتهيئة عند بدء تشغيل الخادم
// إذا حدث خطأ هنا، سيفشل بدء تشغيل الخادم، وهو أمر جيد لأنه يشير لمشكلة في الإعداد
try {
    initializeFirebaseAdmin();
} catch (initError) {
    console.error("Failed to start server due to Firebase initialization error:", initError.message);
    process.exit(1); // أوقف العملية إذا فشلت التهيئة الحرجة
}


// Middleware لتحليل أجسام طلبات JSON
app.use(bodyParser.json());
// Middleware لتحليل أجسام طلبات URL-encoded (أقل استخداماً هنا ولكن قد يكون مفيداً)
app.use(bodyParser.urlencoded({ extended: true }));


// --- نقطة النهاية (Endpoint) لإرسال الإشعارات ---
// يجب تأمين هذه النقطة في بيئة الإنتاج (مثلاً، بالتحقق من Firebase ID Token)
app.post('/send-fcm', async (req, res) => {
  // تأكد أن Firebase Admin SDK تم تهيئته بنجاح
  if (!firebaseAdminInitialized) {
    console.error("Firebase Admin SDK not initialized. Cannot send notification.");
    return res.status(503).json({ success: false, error: "Server configuration error. Firebase not ready." }); // 503 Service Unavailable
  }

  try {
    // استخلاص البيانات من جسم الطلب
    // يفترض أن تطبيق Flutter يرسل Content-Type: application/json
    const { targetUserId, title, body, data = {} } = req.body;

    console.log(`Received request to notify user: ${targetUserId} with title: "${title}"`);

    // التحقق من وجود الحقول المطلوبة
    if (!targetUserId || !title || !body) {
      console.warn("FCM Request: Missing required fields (targetUserId, title, or body).");
      return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    // جلب مستند المستخدم من Firestore للحصول على FCM tokens
    const userDocRef = admin.firestore().collection("users").doc(targetUserId);
    const userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      console.warn(`User not found in Firestore for FCM: ${targetUserId}`);
      return res.status(404).json({ success: false, error: "Target user not found." });
    }

    const userData = userDoc.data();
    const fcmTokens = userData.fcmTokens; // يفترض أن هذا حقل مصفوفة (array)

    if (!Array.isArray(fcmTokens) || fcmTokens.length === 0) {
      console.warn(`No FCM tokens found for user: ${targetUserId}`);
      return res.status(400).json({ success: false, error: "No FCM tokens found for this user." });
    }

    // فلترة الـ tokens للتأكد من أنها سلاسل نصية صالحة وغير فارغة
    const validTokens = fcmTokens.filter(token => typeof token === 'string' && token.trim() !== '');
    if (validTokens.length === 0) {
        console.warn(`No VALID FCM tokens found for user after filtering: ${targetUserId}`);
        return res.status(400).json({ success: false, error: "No valid FCM tokens for user." });
    }

    // تكوين حمولة رسالة FCM
    const messagePayload = {
      tokens: validTokens, // استخدم الـ tokens التي تم التحقق منها
      notification: {
        title: title,
        body: body,
      },
      data: data, // البيانات الإضافية للتوجيه عند فتح الإشعار
      // تخصيص إضافي للإشعارات (اختياري)
      android: {
        priority: 'high', // اجعل الأولوية عالية
        notification: {
          sound: 'default', // الصوت الافتراضي
          // channelId: 'YOUR_NOTIFICATION_CHANNEL_ID', // إذا كان لديك قناة مخصصة
          // icon: 'notification_icon', // اسم أيقونة الإشعار (بدون امتداد) من drawable
          // color: '#FF0000', // لون الأيقونة
        },
      },
      apns: { // إعدادات Apple Push Notification Service
        payload: {
          aps: {
            sound: 'default', // الصوت الافتراضي
            badge: 1, // (اختياري) تحديث شارة الأيقونة
            // 'content-available': 1, // لتحديث التطبيق في الخلفية
          },
        },
      },
    };

    console.log(`Sending FCM message: Title="${messagePayload.notification.title}", Body="${messagePayload.notification.body}", Data=${JSON.stringify(messagePayload.data)} to ${validTokens.length} token(s).`);

    // إرسال الإشعار باستخدام sendEachForMulticast (يعطي تفاصيل أكثر لكل token)
    const response = await admin.messaging().sendEachForMulticast(messagePayload);

    console.log(`FCM send response: SuccessCount=${response.successCount}, FailureCount=${response.failureCount}`);

    // معالجة الـ tokens الفاشلة (اختياري ولكن موصى به)
    if (response.failureCount > 0) {
      const tokensToRemove = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          console.error(`Token failed [${idx}]: ${validTokens[idx]}, Error: ${resp.error?.code} - ${resp.error?.message}`);
          // إذا كان الخطأ يشير إلى أن الـ token لم يعد مسجلاً، قم بإضافته لقائمة الحذف
          if (resp.error && (
              resp.error.code === 'messaging/registration-token-not-registered' ||
              resp.error.code === 'messaging/invalid-registration-token' ||
              resp.error.code === 'messaging/mismatched-credential' // Sometimes indicates an old/invalid token
            )) {
            tokensToRemove.push(validTokens[idx]);
          }
        }
      });

      if (tokensToRemove.length > 0) {
        console.log(`Attempting to remove ${tokensToRemove.length} invalid tokens from user ${targetUserId}.`);
        // استخدام FieldValue.arrayRemove لحذف الـ tokens الفاشلة من مصفوفة fcmTokens للمستخدم
        await userDocRef.update({
          fcmTokens: admin.firestore.FieldValue.arrayRemove(...tokensToRemove)
        });
        console.log(`Successfully attempted to remove invalid tokens for user ${targetUserId}.`);
      }
    }

    // إرجاع استجابة ناجحة
    return res.status(200).json({
      success: true,
      message: `Notification sent. Success: ${response.successCount}, Failures: ${response.failureCount}.`,
      successCount: response.successCount,
      failureCount: response.failureCount,
    });

  } catch (err) {
    // معالجة أي أخطاء غير متوقعة
    console.error(`Unhandled error in /send-fcm endpoint: ${err.message}`, err.stack);
    return res.status(500).json({ success: false, error: `Internal server error: ${err.message}` });
  }
});

// نقطة نهاية أساسية للتحقق من أن الخادم يعمل (Health Check)
app.get('/', (req, res) => {
  res.status(200).send('Saadny FCM Notification Server is running!');
});

// بدء تشغيل الخادم
app.listen(port, () => {
  console.log(`Saadny FCM Notification Server listening on port ${port}`);
});
