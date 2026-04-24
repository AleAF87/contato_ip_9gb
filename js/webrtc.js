import {
    ref,
    onValue,
    push,
    set,
    get,
    off
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { database, APP_ROOT } from "./firebase-config.js";

const RTC_CONFIG = {
    iceServers: [
        { urls: ["stun:stun.l.google.com:19302"] }
    ]
};

async function waitForOffer(callId, attempts = 20, delayMs = 500) {
    for (let index = 0; index < attempts; index += 1) {
        const snapshot = await get(ref(database, `${APP_ROOT}/calls/${callId}/offer`));
        if (snapshot.exists()) {
            return snapshot.val();
        }

        await new Promise((resolve) => {
            window.setTimeout(resolve, delayMs);
        });
    }

    throw new Error("Offer nao encontrada dentro do tempo esperado.");
}

export class WebRTCManager {
    constructor(options) {
        this.sessionId = options.sessionId;
        this.onRemoteStream = options.onRemoteStream;
        this.onConnectionState = options.onConnectionState;
        this.localStream = null;
        this.remoteStream = null;
        this.peerConnection = null;
        this.callRef = null;
        this.remoteCandidatesRef = null;
        this.remoteCandidatesCallback = null;
        this.answerCallback = null;
        this.appliedCandidateKeys = new Set();
    }

    async ensureLocalStream() {
        if (this.localStream) {
            return this.localStream;
        }

        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("[webrtc] Microfone capturado");
        return this.localStream;
    }

    async createPeerConnection(callId, role) {
        if (this.peerConnection) {
            return this.peerConnection;
        }

        await this.ensureLocalStream();

        this.callRef = ref(database, `${APP_ROOT}/calls/${callId}`);
        this.peerConnection = new RTCPeerConnection(RTC_CONFIG);
        this.remoteStream = new MediaStream();

        this.localStream.getTracks().forEach((track) => {
            this.peerConnection.addTrack(track, this.localStream);
        });

        this.peerConnection.ontrack = (event) => {
            event.streams[0].getTracks().forEach((track) => this.remoteStream.addTrack(track));
            this.onRemoteStream?.(this.remoteStream);
            console.log("[webrtc] Faixa remota recebida");
        };

        this.peerConnection.onconnectionstatechange = () => {
            const state = this.peerConnection?.connectionState || "new";
            console.log("[webrtc] Estado da conexao:", state);
            this.onConnectionState?.(state);
        };

        this.peerConnection.onicecandidate = async (event) => {
            if (!event.candidate) {
                return;
            }

            const targetPath = role === "caller" ? "callerCandidates" : "calleeCandidates";
            await push(ref(database, `${APP_ROOT}/calls/${callId}/${targetPath}`), event.candidate.toJSON());
            console.log("[webrtc] ICE enviado:", role);
        };

        return this.peerConnection;
    }

    async createOffer(callId) {
        const pc = await this.createPeerConnection(callId, "caller");
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await set(ref(database, `${APP_ROOT}/calls/${callId}/offer`), {
            type: offer.type,
            sdp: offer.sdp
        });
        console.log("[webrtc] Offer criada");
    }

    async acceptOfferAndCreateAnswer(callId) {
        const pc = await this.createPeerConnection(callId, "callee");
        const offer = await waitForOffer(callId);

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await set(ref(database, `${APP_ROOT}/calls/${callId}/answer`), {
            type: answer.type,
            sdp: answer.sdp
        });
        console.log("[webrtc] Answer criada");
    }

    listenForAnswer(callId) {
        this.callRef = ref(database, `${APP_ROOT}/calls/${callId}`);
        this.answerCallback = async (snapshot) => {
            const data = snapshot.val();
            if (!data?.answer || !this.peerConnection) {
                return;
            }

            if (!this.peerConnection.currentRemoteDescription) {
                await this.peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
                console.log("[webrtc] Answer aplicada");
            }
        };

        onValue(this.callRef, this.answerCallback);
    }

    listenForRemoteCandidates(callId, role) {
        const remotePath = role === "caller" ? "calleeCandidates" : "callerCandidates";
        this.remoteCandidatesRef = ref(database, `${APP_ROOT}/calls/${callId}/${remotePath}`);
        this.remoteCandidatesCallback = async (snapshot) => {
            const items = snapshot.val();
            if (!items || !this.peerConnection) {
                return;
            }

            const entries = Object.entries(items);
            for (const [candidateKey, candidate] of entries) {
                if (!candidate || this.appliedCandidateKeys.has(candidateKey)) {
                    continue;
                }

                try {
                    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                    this.appliedCandidateKeys.add(candidateKey);
                    console.log("[webrtc] ICE remoto aplicado:", role);
                } catch (error) {
                    console.warn("[webrtc] Falha ao aplicar ICE remoto:", error);
                }
            }
        };

        onValue(this.remoteCandidatesRef, this.remoteCandidatesCallback);
    }

    async close() {
        if (this.remoteCandidatesRef && this.remoteCandidatesCallback) {
            off(this.remoteCandidatesRef, "value", this.remoteCandidatesCallback);
        }

        if (this.callRef && this.answerCallback) {
            off(this.callRef, "value", this.answerCallback);
        }

        if (this.peerConnection) {
            this.peerConnection.onicecandidate = null;
            this.peerConnection.ontrack = null;
            this.peerConnection.onconnectionstatechange = null;
            this.peerConnection.close();
        }

        if (this.localStream) {
            this.localStream.getTracks().forEach((track) => track.stop());
        }

        if (this.remoteStream) {
            this.remoteStream.getTracks().forEach((track) => track.stop());
        }

        this.localStream = null;
        this.remoteStream = null;
        this.peerConnection = null;
        this.callRef = null;
        this.remoteCandidatesRef = null;
        this.remoteCandidatesCallback = null;
        this.answerCallback = null;
        this.appliedCandidateKeys.clear();

        console.log("[webrtc] Recursos encerrados");
    }
}
