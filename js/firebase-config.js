import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

const firebaseConfig = {
    apiKey: "AIzaSyAOmHlVtxrYpThcLcL8cQTrH1cdB-w2ICE",
    authDomain: "dejem-9gb.firebaseapp.com",
    databaseURL: "https://dejem-9gb-default-rtdb.firebaseio.com",
    projectId: "dejem-9gb",
    storageBucket: "dejem-9gb.firebasestorage.app",
    messagingSenderId: "280837032740",
    appId: "1:280837032740:web:345e6160e93c51c10401b1"
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);
const APP_ROOT = "contato_ip_9gb";

export { app, database, firebaseConfig, APP_ROOT };
