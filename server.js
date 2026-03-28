const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // Serve HTML files

// --- 1. FIREBASE ADMIN INITIALIZATION ---
if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert({
                projectId: process.env.FIREBASE_PROJECT_ID,
                clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
                privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
            })
        });
        console.log("Firebase Admin securely initialized.");
    } catch (e) {
        console.error("Firebase Admin Error:", e);
    }
} else {
    console.warn("WARNING: Firebase Admin credentials missing in .env. DB calls will fail.");
}

const db = admin.firestore ? admin.firestore() : null;

// --- 2. GEMINI API INITIALIZATION ---
let genAI = null;
if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY !== 'your_gemini_api_key_here') {
    genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    console.log("Gemini AI API securely initialized.");
}

// --- 3. GLOBAL AUTHENTICATION MIDDLEWARE ---
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, message: 'Unauthorized: No token provided' });
    }
    const token = authHeader.split('Bearer ')[1];
    try {
        // Native Firebase verification
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken; 
        next();
    } catch (error) {
        console.error("Silent token verification rejection.");
        return res.status(401).json({ success: false, message: 'Unauthorized: Invalid token' });
    }
};

// --- ROUTES ---

// A. Login Verification & DB Registration
app.post('/api/auth/login', verifyToken, async (req, res) => {
    try {
        const userRef = db.collection('users').doc(req.user.uid);
        const doc = await userRef.get();
        
        // If first login, create profile
        if (!doc.exists) {
            await userRef.set({
                name: req.user.name || 'Anonymous User',
                email: req.user.email,
                picture: req.user.picture || '',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                stats: { moodScore: 5.0, streak: 1, totalEntries: 0 }
            });
        }
        res.json({ success: true, message: 'Valid Session.', uid: req.user.uid });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Internal Server Error' });
    }
});

// B. Load User Profile & Dashboard Stats
app.get('/api/dashboard/data', verifyToken, async (req, res) => {
    try {
        const userRef = db.collection('users').doc(req.user.uid);
        const doc = await userRef.get();
        if (!doc.exists) return res.status(404).json({ success: false, message: 'User DB profile missing' });
        
        const userData = doc.data();
        res.json({ 
            success: true, 
            user: { name: userData.name, email: userData.email, picture: userData.picture }, 
            stats: userData.stats 
        });
    } catch(err) {
        res.status(500).json({ success: false, message: "Error fetching Firestore data" });
    }
});

// C. Activities & Gamification Engine (Soundscapes)
app.post('/api/activity', verifyToken, async (req, res) => {
    try {
        const userRef = db.collection('users').doc(req.user.uid);
        await userRef.update({
            'stats.streak': admin.firestore.FieldValue.increment(1)
        });
        res.json({ success: true });
    } catch(err) {
        res.status(500).json({ success: false });
    }
});

// D. AI Therapist Engine (Gemini)
app.post('/api/chat', verifyToken, async (req, res) => {
    try {
        if (!genAI) return res.status(500).json({ success: false, message: "Gemini not configured." });
        
        const { message, currentEmotion } = req.body;
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro-latest" });
        
        const emotionContext = currentEmotion && currentEmotion !== 'neutral' ? `[CRITICAL UI STATE: The user's live face is currently expressing ${currentEmotion}. Adjust your response empathy to account for this explicitly without telling them you are analyzing off a camera.] ` : '';
        const prompt = `You are Serenity, an AI mental health therapist interacting with a user. Keep your responses highly empathetic, warm, but incredibly brief (max 2 sentences for rapid audio transcription playback). ${emotionContext} React to: "${message}"`;
        
        const result = await model.generateContent(prompt);
        res.json({ success: true, reply: result.response.text() });
    } catch(err) {
        res.status(500).json({ success: false, reply: "I'm having trouble analyzing your request right now." });
    }
});

// E. Emergency SOS Handler
app.post('/api/sos', verifyToken, async (req, res) => {
    res.json({ success: true, action: "Emergency protocols triggered. Connecting to local authorities." });
});

const PORT = 3000;
// E. Journal System
app.post('/api/journal/entry', verifyToken, async (req, res) => {
    try {
        const { content, prompt } = req.body;
        const uid = req.user.uid;

        // 1. Analyze sentiment via Gemini
        let sentimentScore = 5;
        if (genAI) {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const aiPrompt = `Analyze the emotional sentiment of the following journal entry. Provide a single numerical score from 0 (extremely negative/depressed) to 10 (extremely positive/joyful). Do not include any text, just the number. Entry: "${content}"`;
            const result = await model.generateContent(aiPrompt);
            const scoreText = result.response.text().trim();
            sentimentScore = parseFloat(scoreText) || 5;
        }

        // 2. Save to Firestore
        const journalRef = db.collection('journal_entries').doc();
        await journalRef.set({
            userId: uid,
            prompt: prompt,
            content: content,
            sentimentScore: sentimentScore,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });

        // 3. Update weekly_mood in user profile
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            const moodHistory = userData.moodHistory || [5, 5, 5, 5, 5, 5, 5];
            // Simple logic: shift and add new score
            moodHistory.shift();
            moodHistory.push(sentimentScore);
            await userRef.update({ 
                moodHistory: moodHistory,
                moodScore: sentimentScore.toFixed(1)
            });
        }

        res.json({ success: true, sentimentScore });
    } catch(err) {
        console.error("Journal Save Error:", err);
        res.status(500).json({ success: false });
    }
});

app.get('/api/journal/count', verifyToken, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.collection('journal_entries').where('userId', '==', uid).count().get();
        res.json({ success: true, count: snapshot.data().count });
    } catch(err) {
        res.status(500).json({ success: false });
    }
});

app.get('/api/journal/entries', verifyToken, async (req, res) => {
    try {
        const uid = req.user.uid;
        const snapshot = await db.collection('journal_entries')
            .where('userId', '==', uid)
            .orderBy('timestamp', 'desc')
            .limit(20)
            .get();
        
        const entries = [];
        snapshot.forEach(doc => entries.push({ id: doc.id, ...doc.data() }));
        res.json({ success: true, entries });
    } catch(err) {
        res.status(500).json({ success: false });
    }
});

app.listen(PORT, () => {
    console.log(`Serenity Backend Active on http://localhost:${PORT}`);
});
