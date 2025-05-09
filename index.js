import express from "express";
import admin from "firebase-admin";
import serviceAccount from "./serviceAccountKey.json" assert { type: "json" };

const app = express();
const port = process.env.PORT || 3000;

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

app.use(express.json());

app.post("/send", async (req, res) => {
  const { token, title, body } = req.body;

  try {
    const message = {
      notification: {
        title,
        body,
      },
      token,
    };

    const response = await admin.messaging().send(message);
    res.send({ success: true, response });
  } catch (error) {
    res.status(500).send({ success: false, error: error.message });
  }
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
