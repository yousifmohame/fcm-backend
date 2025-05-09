// main.js (أو اسم الملف الرئيسي لدالة Appwrite الخاصة بك)
const admin = require("firebase-admin");

// متغير لتتبع ما إذا كان Firebase قد تم تهيئته بالفعل
let firebaseInitialized = false;

// دالة لتهيئة Firebase Admin SDK
// يتم استدعاؤها مرة واحدة فقط عند أول طلب للدالة أو عند بدء التشغيل البارد.
function initFirebase() {
  if (!firebaseInitialized) {
    try {
      // تأكد من أن متغيرات البيئة هذه تم ضبطها في إعدادات دالة Appwrite
      // FIREBASE_SERVICE_ACCOUNT يجب أن يكون سلسلة JSON كاملة لمفتاح حساب الخدمة
      // FIREBASE_PROJECT_ID هو معرف مشروع Firebase الخاص بك
      const serviceAccountString = process.env.FIREBASE_SERVICE_ACCOUNT;
      const projectId = process.env.FIREBASE_PROJECT_ID;

      if (!serviceAccountString) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT environment variable is not set.");
      }
      if (!projectId) {
        throw new Error("FIREBASE_PROJECT_ID environment variable is not set.");
      }

      const serviceAccount = JSON.parse(serviceAccountString);

      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        projectId: projectId, // يمكن استنتاجه من serviceAccount، ولكن من الجيد تحديده
      });
      firebaseInitialized = true;
      console.log("Firebase Admin SDK initialized successfully.");
    } catch (error) {
      console.error("Error initializing Firebase Admin SDK:", error);
      // إذا فشلت التهيئة، يجب أن لا تستمر الدالة
      throw new Error(`Firebase initialization failed: ${error.message}`);
    }
  }
}

// نقطة الدخول الرئيسية لدالة Appwrite
module.exports = async ({ req, res, log, error }) => {
  // Appwrite يوفر log و error كجزء من السياق، يمكنك استخدامهما بدلاً من console.log/error إذا أردت
  // log("Function execution started.");

  try {
    // 1. التأكد من أن الطلب هو POST
    if (req.method !== "POST") {
      error("Invalid request method. Only POST is allowed.");
      return res.json(
        { success: false, error: "Only POST requests are allowed." },
        405 // Method Not Allowed
      );
    }

    // 2. تهيئة Firebase Admin SDK (سيتم تهيئته مرة واحدة فقط)
    initFirebase();

    // 3. استخلاص البيانات من جسم الطلب (req.body)
    // Appwrite عادةً ما يقوم بتحليل JSON body تلقائياً، لذا req.body يكون كائنًا (object)
    // إذا كان req.body سلسلة نصية، فهذا يعني أن Content-Type لم يتم ضبطه كـ application/json من جهة Flutter
    // أو أن هناك مشكلة في كيفية إرسال البيانات.
    let payload = {};
    if (typeof req.body === 'string' && req.body.trim() !== '') {
        try {
            payload = JSON.parse(req.body);
        } catch (parseError) {
            error(`Invalid JSON in request body: ${req.body}. Error: ${parseError.message}`);
            return res.json({ success: false, error: "Invalid JSON body." }, 400);
        }
    } else if (typeof req.body === 'object' && req.body !== null) {
        payload = req.body;
    } else {
        error("Request body is empty or not in expected format.");
        return res.json({ success: false, error: "Request body is empty or invalid." }, 400);
    }

    const {
      targetUserId,
      title,
      body,
      data = {}, // بيانات إضافية (مثل screen, id للتوجيه) - قيمة افتراضية ككائن فارغ
    } = payload;

    // 4. التحقق من وجود الحقول المطلوبة
    if (!targetUserId || !title || !body) {
      error("Missing required fields: targetUserId, title, or body.");
      return res.json(
        { success: false, error: "Missing required fields (targetUserId, title, body)." },
        400 // Bad Request
      );
    }

    log(`Attempting to send notification to user: ${targetUserId}`);

    // 5. جلب مستند المستخدم من Firestore للحصول على FCM tokens
    const userDoc = await admin
      .firestore()
      .collection("users") // تأكد أن هذا هو اسم الـ collection الصحيح
      .doc(targetUserId)
      .get();

    if (!userDoc.exists) {
      error(`User not found in Firestore: ${targetUserId}`);
      return res.json({ success: false, error: "User not found." }, 404); // Not Found
    }

    // 6. الحصول على FCM tokens والتحقق منها
    // يفترض أن 'fcmTokens' هو حقل من نوع مصفوفة (array) في مستند المستخدم
    const userData = userDoc.data();
    const fcmTokens = userData.fcmTokens;

    if (!Array.isArray(fcmTokens) || fcmTokens.length === 0) {
      error(`No FCM tokens found for user: ${targetUserId}`);
      return res.json(
        { success: false, error: "No FCM tokens found for this user." },
        400 // Bad Request (أو 404 إذا اعتبرنا أن المستخدم غير قابل للوصول)
      );
    }

    // (اختياري) فلترة الـ tokens للتأكد من أنها سلاسل نصية صالحة وغير فارغة
    const validTokens = fcmTokens.filter(token => typeof token === 'string' && token.trim() !== '');
    if (validTokens.length === 0) {
        error(`No VALID FCM tokens found for user after filtering: ${targetUserId}`);
        return res.json({ success: false, error: "No valid FCM tokens for user." }, 400);
    }

    // 7. تكوين رسالة FCM
    const message = {
      tokens: validTokens, // استخدم الـ tokens التي تم التحقق منها
      notification: {
        title: title,
        body: body,
      },
      data: data, // البيانات الإضافية للتوجيه عند فتح الإشعار
      // يمكنك إضافة خيارات Android و APNS هنا إذا أردت تخصيصاً أكبر
      // android: { notification: { sound: 'default', channelId: 'your_channel_id' } },
      // apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    };

    log(`Sending FCM message: ${JSON.stringify(message.notification)} with data ${JSON.stringify(data)} to ${validTokens.length} token(s).`);

    // 8. إرسال الإشعار باستخدام sendMulticast
    const response = await admin.messaging().sendEachForMulticast(message); // sendEachForMulticast يعطي تفاصيل أكثر لكل token

    log(`FCM send response: SuccessCount=${response.successCount}, FailureCount=${response.failureCount}`);

    // (اختياري) معالجة الـ tokens الفاشلة (مثلاً، حذفها من Firestore)
    if (response.failureCount > 0) {
      const failedTokens = [];
      response.responses.forEach((resp, idx) => {
        if (!resp.success) {
          failedTokens.push(validTokens[idx]);
          error(`Token failed: ${validTokens[idx]}, Error: ${resp.error}`);
          // يمكنك هنا إضافة منطق لحذف الـ tokens الفاشلة من Firestore
          // if (resp.error.code === 'messaging/registration-token-not-registered' ||
          //     resp.error.code === 'messaging/invalid-registration-token') {
          //   // Remove token from user's fcmTokens array in Firestore
          // }
        }
      });
      log(`Failed tokens: ${failedTokens.join(', ')}`);
    }

    // 9. إرجاع استجابة ناجحة
    return res.json({
      success: true,
      message: `Notification sent. Success: ${response.successCount}, Failures: ${response.failureCount}.`,
      successCount: response.successCount,
      failureCount: response.failureCount,
      // results: response.responses // يمكنك إرجاع النتائج التفصيلية إذا أردت
    });

  } catch (err) {
    // معالجة أي أخطاء غير متوقعة
    error(`Unhandled error in function: ${err.message}`);
    console.error(err); // اطبع الخطأ الكامل في سجلات الدالة لمزيد من التفاصيل
    return res.json({ success: false, error: `Internal server error: ${err.message}` }, 500);
  }
};

