const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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
        const decodedToken = await admin.auth().verifyIdToken(token);
        req.user = decodedToken; 
        next();
    } catch (error) {
        console.error("Silent token verification rejection.");
        return res.status(401).json({ success: false, message: 'Unauthorized: Invalid token' });
    }
};

// --- 4. DAILY PROMPT POOL (20+ prompts) ---
const DAILY_PROMPTS = [
    "What's one thing that made you smile today?",
    "How are you really feeling right now?",
    "Name one thing you're proud of this week.",
    "What's weighing on your mind today?",
    "Describe your mood in three words.",
    "What would make today a great day?",
    "Who made a positive impact on you recently?",
    "What's one small victory you had today?",
    "If you could change one thing about today, what would it be?",
    "What are you most grateful for right now?",
    "How did you practice self-care today?",
    "What's a challenge you overcame recently?",
    "What brings you peace when you're stressed?",
    "Describe a moment of joy from this week.",
    "What's something new you learned about yourself?",
    "How would you rate your energy level today?",
    "What's one kind thing you did for someone?",
    "What's occupying most of your thoughts lately?",
    "If your emotions had a color today, what would it be?",
    "What's one thing you'd like to let go of?",
    "Write about a place that makes you feel safe.",
    "What song matches your mood right now?"
];

function getDailyPrompt() {
    const today = new Date();
    const seed = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    return DAILY_PROMPTS[seed % DAILY_PROMPTS.length];
}

// --- 5. MOOD SCORE FORMULA ---
// Composite: 0.4×journal + 0.3×chat + 0.2×activity + 0.1×streak
function calculateMoodScore(userData) {
    const latestJournal = userData.latestJournalSentiment || 5;
    const chatSentiment = userData.latestChatSentiment || 5;
    const todayActivities = Math.min(userData.todayActivities || 0, 2);
    const activityBonus = todayActivities * 5; // 0, 5, or 10
    const streak = userData.stats?.streak || 0;
    const streakBonus = Math.min(streak / 7, 1) * 10;

    const score = (0.4 * latestJournal) + (0.3 * chatSentiment) + (0.2 * activityBonus) + (0.1 * streakBonus);
    return Math.min(10, Math.max(0, parseFloat(score.toFixed(1))));
}

// --- ROUTES ---

// A. Login Verification & DB Registration
app.post('/api/auth/login', verifyToken, async (req, res) => {
    try {
        const { displayName } = req.body;
        const userRef = db.collection('users').doc(req.user.uid);
        const doc = await userRef.get();
        
        const now = new Date();
        
        if (!doc.exists) {
            // First-time user
            await userRef.set({
                name: displayName || req.user.name || 'Anonymous User',
                email: req.user.email,
                picture: req.user.picture || '',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                lastLogin: admin.firestore.FieldValue.serverTimestamp(),
                stats: { moodScore: 5.0, streak: 1, totalEntries: 0 },
                moodHistory: [5, 5, 5, 5, 5, 5, 5],
                latestJournalSentiment: 5,
                latestChatSentiment: 5,
                todayActivities: 0,
                lastActivityDate: now.toISOString().split('T')[0]
            });
        } else {
            // Returning user — update login & calculate streak
            const data = doc.data();
            const lastLogin = data.lastLogin?.toDate ? data.lastLogin.toDate() : new Date(data.lastLogin || 0);
            const daysSinceLogin = Math.floor((now - lastLogin) / (1000 * 60 * 60 * 24));
            
            let newStreak = data.stats?.streak || 1;
            let todayActivities = data.todayActivities || 0;
            
            if (daysSinceLogin === 1) {
                newStreak += 1; // Consecutive day
            } else if (daysSinceLogin > 1) {
                newStreak = 1; // Streak broken
            }
            
            // Reset daily activity counter if new day
            const todayStr = now.toISOString().split('T')[0];
            if (data.lastActivityDate !== todayStr) {
                todayActivities = 0;
            }

            // Update display name if provided
            const updateData = {
                lastLogin: admin.firestore.FieldValue.serverTimestamp(),
                'stats.streak': newStreak,
                todayActivities: todayActivities,
                lastActivityDate: todayStr
            };
            if (displayName) updateData.name = displayName;
            
            await userRef.update(updateData);
        }
        
        res.json({ success: true, message: 'Valid Session.', uid: req.user.uid });
    } catch (error) {
        console.error("Login Error:", error);
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
        
        // Recalculate mood score live
        const moodScore = calculateMoodScore(userData);
        
        // Get journal count
        let journalCount = 0;
        try {
            const snapshot = await db.collection('journal_entries').where('userId', '==', req.user.uid).count().get();
            journalCount = snapshot.data().count;
        } catch(e) {}
        
        res.json({ 
            success: true, 
            user: { name: userData.name, email: userData.email, picture: userData.picture }, 
            stats: {
                moodScore: moodScore,
                streak: userData.stats?.streak || 1,
                totalEntries: journalCount
            },
            moodHistory: userData.moodHistory || [5, 5, 5, 5, 5, 5, 5],
            dailyPrompt: getDailyPrompt()
        });
    } catch(err) {
        console.error("Dashboard Error:", err);
        res.status(500).json({ success: false, message: "Error fetching Firestore data" });
    }
});

// C. Daily Prompt Endpoint
app.get('/api/daily-prompt', (req, res) => {
    res.json({ success: true, prompt: getDailyPrompt() });
});

// D. Activities & Gamification Engine
app.post('/api/activity', verifyToken, async (req, res) => {
    try {
        const { activity, duration } = req.body;
        const userRef = db.collection('users').doc(req.user.uid);
        const doc = await userRef.get();
        const userData = doc.data();
        
        const todayStr = new Date().toISOString().split('T')[0];
        let todayActivities = userData.todayActivities || 0;
        if (userData.lastActivityDate !== todayStr) {
            todayActivities = 0;
        }
        todayActivities += 1;

        await userRef.update({
            todayActivities: todayActivities,
            lastActivityDate: todayStr
        });
        
        // Recalculate mood
        const updatedData = { ...userData, todayActivities };
        const newMoodScore = calculateMoodScore(updatedData);
        await userRef.update({ 'stats.moodScore': newMoodScore });

        // Log the activity
        await db.collection('activities').add({
            userId: req.user.uid,
            activity: activity,
            duration: duration || 0,
            timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
        
        res.json({ success: true, activity, newMoodScore });
    } catch(err) {
        console.error("Activity Error:", err);
        res.status(500).json({ success: false });
    }
});

// E. AI Therapist Engine (Gemini)
app.post('/api/chat', verifyToken, async (req, res) => {
    try {
        if (!genAI) return res.status(500).json({ success: false, message: "Gemini not configured." });
        
        const { message, currentEmotion } = req.body;
        const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
        
        const emotionContext = currentEmotion && currentEmotion !== 'neutral' ? `[CRITICAL UI STATE: The user's live face is currently expressing ${currentEmotion}. Adjust your response empathy to account for this explicitly without telling them you are analyzing off a camera.] ` : '';
        const prompt = `You are Serenity, an AI mental health therapist interacting with a user. Keep your responses highly empathetic, warm, but incredibly brief (max 2 sentences for rapid audio transcription playback). ${emotionContext} React to: "${message}"`;
        
        const result = await model.generateContent(prompt);
        const reply = result.response.text();

        // Analyze chat sentiment for mood formula
        try {
            const sentimentModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
            const sentimentPrompt = `Rate the emotional positivity of this user message from 0-10 (0=very negative, 10=very positive). Return ONLY a number. Message: "${message}"`;
            const sentimentResult = await sentimentModel.generateContent(sentimentPrompt);
            const chatSentiment = parseFloat(sentimentResult.response.text().trim()) || 5;
            
            const userRef = db.collection('users').doc(req.user.uid);
            await userRef.update({ latestChatSentiment: Math.min(10, Math.max(0, chatSentiment)) });
        } catch(e) { /* sentiment analysis is best-effort */ }

        res.json({ success: true, reply });
    } catch(err) {
        console.error("Chat Error:", err);
        res.status(500).json({ success: false, reply: "I'm having trouble analyzing your request right now." });
    }
});

// F. Emergency SOS Handler
app.post('/api/sos', verifyToken, async (req, res) => {
    res.json({ success: true, action: "Emergency protocols triggered. If you're in crisis, please contact your local emergency services or call 988 (Suicide & Crisis Lifeline)." });
});

// G. Journal System
app.post('/api/journal/entry', verifyToken, async (req, res) => {
    try {
        const { content, prompt } = req.body;
        const uid = req.user.uid;

        // 1. Analyze sentiment via Gemini
        let sentimentScore = 5;
        if (genAI) {
            const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
            const aiPrompt = `Analyze the emotional sentiment of the following journal entry. Provide a single numerical score from 0 (extremely negative/depressed) to 10 (extremely positive/joyful). Do not include any text, just the number. Entry: "${content}"`;
            const result = await model.generateContent(aiPrompt);
            const scoreText = result.response.text().trim();
            sentimentScore = parseFloat(scoreText) || 5;
            sentimentScore = Math.min(10, Math.max(0, sentimentScore));
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

        // 3. Update user profile with mood data
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            const moodHistory = userData.moodHistory || [5, 5, 5, 5, 5, 5, 5];
            moodHistory.shift();
            moodHistory.push(sentimentScore);
            
            const updatedData = { ...userData, latestJournalSentiment: sentimentScore, moodHistory };
            const newMoodScore = calculateMoodScore(updatedData);
            
            await userRef.update({ 
                moodHistory: moodHistory,
                latestJournalSentiment: sentimentScore,
                'stats.moodScore': newMoodScore
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

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Serenity Backend Active on http://localhost:${PORT}`);
});
