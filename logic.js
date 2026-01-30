/**
 * logic.js
 * Contains both StorageManager (Firebase) and QuizApp logic
 * Configured for standalone deployment of soal1.
 */

// --- Firebase & StorageManager Logic ---

// Wrapper to prevent multiple inits if this file is loaded multiple times or alongside storage.js
(function () {

    // Firebase Configuration
    const firebaseConfig = {
        apiKey: "AIzaSyAO-CTf7DVqkD-V-_mtL7e9hP5QNf7vkQM",
        authDomain: "dkotobakuis-c69a1.firebaseapp.com",
        projectId: "dkotobakuis-c69a1",
        storageBucket: "dkotobakuis-c69a1.firebasestorage.app",
        messagingSenderId: "935131530677",
        appId: "1:935131530677:web:d4f77248f542a2f39745fc"
    };

    // Initialize Firebase (check if already initialized)
    if (!firebase.apps.length) {
        firebase.initializeApp(firebaseConfig);
    }

    // Global references
    const auth = firebase.auth();
    const firestore = firebase.firestore();

    const USERS_COLLECTION = 'users';

    const getEmail = (username) => `${username.toLowerCase()}@dkotoba.app`;

    class StorageManager {
        constructor() {
            this.currentUser = null;
            window.dbRef = this;
        }

        // --- Helpers ---
        async getCurrentUser() {
            return new Promise((resolve) => {
                const unsubscribe = auth.onAuthStateChanged(async (user) => {
                    if (user) {
                        const docRef = firestore.collection(USERS_COLLECTION).doc(user.uid);
                        try {
                            const doc = await docRef.get();
                            if (doc.exists) {
                                this.currentUser = { id: user.uid, ...doc.data() };
                                resolve(this.currentUser);
                            } else {
                                resolve(null);
                            }
                        } catch (e) {
                            console.error("Firestore error:", e);
                            resolve(null);
                        }
                    } else {
                        this.currentUser = null;
                        resolve(null);
                    }
                    unsubscribe();
                });
            });
        }

        // --- Auth (Async) ---
        async login(username, password) {
            try {
                const email = getEmail(username);
                const userCredential = await auth.signInWithEmailAndPassword(email, password);
                const uid = userCredential.user.uid;
                const doc = await firestore.collection(USERS_COLLECTION).doc(uid).get();
                if (doc.exists) {
                    this.currentUser = { id: uid, ...doc.data() };
                    return { success: true, user: this.currentUser };
                } else {
                    return { success: false, message: 'Data user tidak ditemukan.' };
                }
            } catch (error) {
                console.error("Login Error:", error);
                return { success: false, message: 'Username atau password salah.' };
            }
        }

        async register(username, password, fullName = '') {
            try {
                const email = getEmail(username);
                const userCredential = await auth.createUserWithEmailAndPassword(email, password);
                const uid = userCredential.user.uid;

                const newUser = {
                    id: uid,
                    username: username,
                    fullName: fullName,
                    role: 'user',
                    score: 0,
                    completedQuizzes: 0,
                    history: [],
                    quizHistoryDetails: {},
                    createdAt: new Date().toISOString()
                };

                await firestore.collection(USERS_COLLECTION).doc(uid).set(newUser);
                return { success: true, user: newUser };

            } catch (error) {
                console.error("Register Error:", error);
                if (error.code === 'auth/email-already-in-use') {
                    return { success: false, message: 'Username sudah digunakan.' };
                }
                return { success: false, message: error.message };
            }
        }

        async checkUserStatus(username) {
            try {
                const user = await this.getUserByUsername(username);
                if (user) {
                    return 'existing';
                }
                return 'new';
            } catch (error) {
                console.error("Check User Error:", error);
                return 'new';
            }
        }

        async getUserByUsername(username) {
            try {
                const snapshot = await firestore.collection(USERS_COLLECTION)
                    .where('username', '==', username)
                    .limit(1)
                    .get();

                if (!snapshot.empty) {
                    return snapshot.docs[0].data();
                }
                return null;
            } catch (error) {
                console.error("Get User Error:", error);
                return null;
            }
        }

        async updateUserProgress(userId, score, quizId, answers) {
            const userRef = firestore.collection(USERS_COLLECTION).doc(userId);
            await firestore.runTransaction(async (transaction) => {
                const userDoc = await transaction.get(userRef);
                if (!userDoc.exists) throw "User does not exist!";

                const userData = userDoc.data();
                const history = userData.history || [];
                const quizHistoryDetails = userData.quizHistoryDetails || {};
                const alreadyDone = history.includes(quizId);
                let newScore = userData.score || 0;
                let newCompleted = userData.completedQuizzes || 0;

                if (!alreadyDone) {
                    newScore += score;
                    newCompleted += 1;
                    history.push(quizId);
                }

                quizHistoryDetails[quizId] = {
                    score: score,
                    answers: answers,
                    date: new Date().toISOString()
                };

                transaction.update(userRef, {
                    score: newScore,
                    completedQuizzes: newCompleted,
                    history: history,
                    quizHistoryDetails: quizHistoryDetails
                });
            });
        }
    }

    // Expose StorageManager to window if not already present, or use it locally
    window.StorageManager = StorageManager;
})();


// --- Quiz App Logic ---

function quizApp() {
    return {
        currentIndex: 0,
        score: 0,
        correctCount: 0,
        showResult: false,
        showReview: false,
        selectedAnswer: null,
        essayAnswer: '',
        userAnswers: [],
        db: null,
        currentUser: null,

        // Auth Overlay Logic
        showAuthOverlay: false,
        authStep: 'username', // 'username' or 'password'
        authUsername: '',
        authPassword: '',
        authFullName: '',
        authStatus: null, // 'new' or 'existing'
        authLoading: false,
        authError: '',

        async init() {
            // Initialize StorageManager
            if (typeof window.StorageManager !== 'undefined') {
                this.db = new window.StorageManager();
                this.currentUser = await this.db.getCurrentUser();
            } else {
                console.error("StorageManager not defined! Check logic.js.");
            }

            // Get Quiz ID and Mode from URL
            const params = new URLSearchParams(window.location.search);
            const qId = params.get('quizId');
            const mode = params.get('mode');

            this.quizId = qId ? qId : 'soal1';

            // Enforce Authentication via Overlay instead of Redirect
            if (!this.currentUser) {
                this.showAuthOverlay = true;
            } else {
                this.checkReviewMode(mode);
            }
        },

        async checkUsername() {
            if (!this.authUsername) return;
            this.authLoading = true;
            this.authError = '';

            try {
                const status = await this.db.checkUserStatus(this.authUsername);
                this.authStatus = status;

                if (status === 'existing') {
                    const userData = await this.db.getUserByUsername(this.authUsername);
                    if (userData) {
                        this.currentUser = userData;
                        this.showAuthOverlay = false;
                        const params = new URLSearchParams(window.location.search);
                        this.checkReviewMode(params.get('mode'));
                    } else {
                        this.authError = "Gagal memuat data user.";
                    }
                } else {
                    this.authStep = 'password';
                }
            } catch (e) {
                console.error(e);
                this.authError = "Gagal mengecek username.";
            } finally {
                this.authLoading = false;
            }
        },

        async submitAuth() {
            if (!this.authPassword) return;
            // Validation for new user
            if (this.authStatus === 'new' && !this.authFullName) {
                this.authError = "Nama Lengkap wajib diisi.";
                return;
            }

            this.authLoading = true;
            this.authError = '';

            try {
                let res;
                if (this.authStatus === 'new') {
                    // Register
                    res = await this.db.register(this.authUsername, this.authPassword, this.authFullName);
                } else {
                    // Login
                    res = await this.db.login(this.authUsername, this.authPassword);
                }

                if (res.success) {
                    this.currentUser = res.user;
                    this.showAuthOverlay = false;
                    // Check if review mode needed
                    const params = new URLSearchParams(window.location.search);
                    this.checkReviewMode(params.get('mode'));
                } else {
                    this.authError = res.message;
                }
            } catch (e) {
                console.error(e);
                this.authError = "Terjadi kesalahan.";
            } finally {
                this.authLoading = false;
            }
        },

        checkReviewMode(mode) {
            // Review Mode logic
            if (mode === 'review' && this.currentUser && this.currentUser.quizHistoryDetails) {
                const history = this.currentUser.quizHistoryDetails[this.quizId];
                if (history && history.answers) {
                    this.userAnswers = history.answers;
                    this.score = history.score;
                    // Calculate correct count
                    this.correctCount = 0;
                    this.questions.forEach((q, idx) => {
                        if (this.isCorrect(idx)) this.correctCount++;
                    });

                    this.showResult = true;
                    this.showReview = true;
                }
            }
        },

        questions: [
            // 20 Multiple Choice Questions (N5)
            { type: 'mc', question: 'ねこ', options: ['neko', 'inu', 'tori', 'uma'], answer: 'neko' },
            { type: 'mc', question: 'いぬ', options: ['neko', 'inu', 'sakana', 'ushi'], answer: 'inu' },
            { type: 'mc', question: 'ほん', options: ['pen', 'hon', 'jisho', 'zasshi'], answer: 'hon' },
            { type: 'mc', question: 'えんぴつ', options: ['pen', 'enpitsu', 'keshigomu', 'fude'], answer: 'enpitsu' },
            { type: 'mc', question: 'がくせい', options: ['sensei', 'gakusei', 'isha', 'kaishain'], answer: 'gakusei' },
            { type: 'mc', question: 'せんせい', options: ['gakusei', 'sensei', 'keisatsu', 'enjinia'], answer: 'sensei' },
            { type: 'mc', question: 'やま', options: ['yama', 'kawa', 'umi', 'sora'], answer: 'yama' },
            { type: 'mc', question: 'かわ', options: ['yama', 'kawa', 'mizu', 'ki'], answer: 'kawa' },
            { type: 'mc', question: 'みず', options: ['mizu', 'ocha', 'gyuunyuu', 'sake'], answer: 'mizu' },
            { type: 'mc', question: 'たべる', options: ['taberu', 'nomu', 'yomu', 'kaku'], answer: 'taberu' },
            { type: 'mc', question: 'のむ', options: ['taberu', 'nomu', 'iku', 'kuru'], answer: 'nomu' },
            { type: 'mc', question: 'いく', options: ['iku', 'kuru', 'kaeru', 'aruku'], answer: 'iku' },
            { type: 'mc', question: 'くる', options: ['iku', 'kuru', 'hau', 'tobu'], answer: 'kuru' },
            { type: 'mc', question: 'おおきい', options: ['ookii', 'chiisai', 'takai', 'hikui'], answer: 'ookii' },
            { type: 'mc', question: 'ちいさい', options: ['ookii', 'chiisai', 'nagai', 'mijikai'], answer: 'chiisai' },
            { type: 'mc', question: 'あかい', options: ['akai', 'aoi', 'shiroi', 'kuroi'], answer: 'akai' },
            { type: 'mc', question: 'しろい', options: ['akai', 'shiroi', 'kiiroi', 'midori'], answer: 'shiroi' },
            { type: 'mc', question: 'いち', options: ['ichi', 'ni', 'san', 'yon'], answer: 'ichi' },
            { type: 'mc', question: 'に', options: ['ichi', 'ni', 'san', 'go'], answer: 'ni' },
            { type: 'mc', question: 'さん', options: ['ni', 'san', 'shi', 'roku'], answer: 'san' },

            // 10 Essay Questions (N5)
            { type: 'essay', question: 'りんご', answer: 'ringo' },
            { type: 'essay', question: 'さかな', answer: 'sakana' },
            { type: 'essay', question: 'とり', answer: 'tori' },
            { type: 'essay', question: 'うみ', answer: 'umi' },
            { type: 'essay', question: 'そら', answer: 'sora' },
            { type: 'essay', question: 'あめ', answer: 'ame' },
            { type: 'essay', question: 'ゆき', answer: 'yuki' },
            { type: 'essay', question: 'はな', answer: 'hana' },
            { type: 'essay', question: 'みみ', answer: 'mimi' },
            { type: 'essay', question: 'て', answer: 'te' }
        ],

        get totalQuestions() { return this.questions.length; },

        get canSubmit() {
            const q = this.questions[this.currentIndex];
            if (q.type === 'mc') return this.selectedAnswer !== null;
            if (q.type === 'essay') return this.essayAnswer.trim() !== '';
            return false;
        },

        selectAnswer(ans) {
            this.selectedAnswer = ans;
        },

        submitEssay() {
            if (this.essayAnswer.trim() !== '') {
                this.submitAnswer();
            }
        },

        submitAnswer() {
            const q = this.questions[this.currentIndex];
            let isCorrect = false;
            let userAnswer = '';

            if (q.type === 'mc') {
                userAnswer = this.selectedAnswer;
                if (this.selectedAnswer === q.answer) isCorrect = true;
            } else {
                userAnswer = this.essayAnswer;
                if (this.essayAnswer.toLowerCase().trim() === q.answer.toLowerCase()) isCorrect = true;
            }

            // Track answer
            this.userAnswers.push(userAnswer);

            if (isCorrect) {
                this.correctCount++;
                this.score += 100 / this.totalQuestions;
            }

            // Reset inputs
            this.selectedAnswer = null;
            this.essayAnswer = '';

            // Next question or Finish
            if (this.currentIndex < this.totalQuestions - 1) {
                this.currentIndex++;
            } else {
                this.finishQuiz();
            }
        },

        isCorrect(index) {
            const q = this.questions[index];
            const userAns = this.userAnswers[index];
            if (!userAns) return false;

            if (q.type === 'mc') {
                return userAns === q.answer;
            } else {
                return userAns.toLowerCase().trim() === q.answer.toLowerCase();
            }
        },

        finishQuiz() {
            this.score = Math.round(this.score);
            this.showResult = true;

            // Save to DB
            if (this.db && this.currentUser && this.quizId) {
                this.db.updateUserProgress(this.currentUser.id, this.score, this.quizId, this.userAnswers);
                console.log('Progress saved for quiz:', this.quizId);
            } else {
                console.warn('StorageManager, CurrentUser, or QuizId not found');
            }
        },

        resetQuiz() {
            this.currentIndex = 0;
            this.score = 0;
            this.correctCount = 0;
            this.showResult = false;
            this.showReview = false;
            this.selectedAnswer = null;
            this.essayAnswer = '';
            this.userAnswers = [];
        }
    }
}
