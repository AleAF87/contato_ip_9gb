import {
    ref,
    set,
    get,
    update,
    remove,
    push,
    onValue,
    onDisconnect,
    runTransaction
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";
import { database, APP_ROOT } from "./firebase-config.js";
import {
    CANAIS_FIXOS,
    getChannelTemplate,
    getStatusLabel,
    getStatusClass,
    findChannelName
} from "./canais.js";
import {
    setupAudio,
    playRingtone,
    stopRingtone,
    attachRemoteStream,
    clearRemoteStream
} from "./audio.js";
import { WebRTCManager } from "./webrtc.js";

const STORAGE_KEY = "contato_ip_9gb_user";
const CALL_TIMEOUT_MS = 30000;
const state = {
    user: null,
    channels: {},
    currentChannelId: "",
    currentCall: null,
    incomingCall: null,
    listenersStarted: false,
    rtcManager: null
};

document.addEventListener("DOMContentLoaded", async () => {
    setupAudio();

    if (document.body.classList.contains("page-auth")) {
        setupIndexPage();
        return;
    }

    if (document.body.classList.contains("page-app")) {
        await setupAppPage();
    }
});

function setupIndexPage() {
    const form = document.getElementById("login-form");
    const input = document.getElementById("username");
    const channelSelect = document.getElementById("home-channel");
    const message = document.getElementById("login-message");

    form?.addEventListener("submit", async (event) => {
        event.preventDefault();

        const userName = input.value.trim();
        const homeChannelId = channelSelect.value;
        if (!userName || !homeChannelId) {
            message.textContent = "Informe seu nome e selecione o seu canal.";
            return;
        }

        const homeChannelName = findChannelName(homeChannelId);

        try {
            await cleanupStaleSessions();
            const membersSnapshot = await get(ref(database, `${APP_ROOT}/channels/${homeChannelId}/members`));
            const members = Object.values(membersSnapshot.val() || {}).filter((member) => member?.id);

            if (members.length) {
                message.textContent = `O canal ${homeChannelName} ja esta sendo usado por ${members[0].name}.`;
                return;
            }
        } catch (error) {
            console.warn("[auth] Nao foi possivel validar ocupacao antes do login:", error);
        }

        const sessionId = crypto.randomUUID();
        const user = {
            id: sessionId,
            name: userName,
            homeChannelId,
            homeChannelName,
            createdAt: Date.now()
        };

        try {
            console.log("[auth] Salvando usuario no Firebase", user);
            await set(ref(database, `${APP_ROOT}/users/${sessionId}`), {
                id: sessionId,
                name: userName,
                homeChannelId,
                homeChannelName,
                status: "online",
                currentChannelId: homeChannelId,
                createdAt: Date.now()
            });

            localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
            window.location.href = "./app.html";
        } catch (error) {
            console.error("[auth] Erro ao entrar:", error);
            message.textContent = "Nao foi possivel entrar agora. Tente novamente.";
        }
    });
}

async function setupAppPage() {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
        window.location.href = "./index.html";
        return;
    }

    state.user = JSON.parse(stored);
    if (!state.user?.id || !state.user?.name || !state.user?.homeChannelId) {
        localStorage.removeItem(STORAGE_KEY);
        window.location.href = "./index.html";
        return;
    }

    state.currentChannelId = state.user.homeChannelId;
    document.getElementById("current-user-name").textContent = state.user.name;

    await ensureInitialData();
    await cleanupStaleSessions();
    await registerPresence();
    bindUiEvents();
    startRealtimeListeners();
    updateHeaderState();

    window.addEventListener("beforeunload", handleBeforeUnload);
}

async function ensureInitialData() {
    const channelsRef = ref(database, `${APP_ROOT}/channels`);
    const snapshot = await get(channelsRef);
    if (!snapshot.exists()) {
        await set(channelsRef, getChannelTemplate());
        console.log("[bootstrap] Canais criados");
    } else {
        const existing = snapshot.val() || {};
        const next = getChannelTemplate();
        const merged = { ...next, ...existing };
        await update(channelsRef, merged);
        console.log("[bootstrap] Canais validados");
    }
}

async function registerPresence() {
    const userRef = ref(database, `${APP_ROOT}/users/${state.user.id}`);
    const presenceRef = ref(database, `${APP_ROOT}/presence/${state.user.id}`);
    const memberRef = ref(database, `${APP_ROOT}/channels/${state.user.homeChannelId}/members/${state.user.id}`);
    const now = Date.now();

    const memberSnapshot = await get(ref(database, `${APP_ROOT}/channels/${state.user.homeChannelId}/members`));
    const presenceSnapshot = await get(ref(database, `${APP_ROOT}/presence`));
    const presenceMap = presenceSnapshot.val() || {};
    const existingMembers = Object.values(memberSnapshot.val() || {}).filter((member) =>
        member?.id &&
        member.id !== state.user.id &&
        presenceMap[member.id]?.online
    );
    if (existingMembers.length) {
        alert(`O canal ${state.user.homeChannelName} ja esta em uso por ${existingMembers[0].name}.`);
        localStorage.removeItem(STORAGE_KEY);
        window.location.href = "./index.html";
        return;
    }

    await update(userRef, {
        name: state.user.name,
        homeChannelId: state.user.homeChannelId,
        homeChannelName: state.user.homeChannelName,
        status: "online",
        currentChannelId: state.user.homeChannelId
    });

    await set(presenceRef, {
        id: state.user.id,
        name: state.user.name,
        homeChannelId: state.user.homeChannelId,
        homeChannelName: state.user.homeChannelName,
        online: true,
        currentChannelId: state.user.homeChannelId
    });

    await set(memberRef, {
        id: state.user.id,
        name: state.user.name,
        joinedAt: now,
        homeChannelId: state.user.homeChannelId
    });

    onDisconnect(presenceRef).remove();
    onDisconnect(memberRef).remove();
    onDisconnect(userRef).update({
        status: "offline",
        currentChannelId: ""
    });
}

function bindUiEvents() {
    document.getElementById("logout-btn")?.addEventListener("click", async () => {
        await cleanupAndExit();
    });

    document.getElementById("end-call-btn")?.addEventListener("click", async () => {
        await endCall("Encerrada manualmente.");
    });

    document.getElementById("accept-call-btn")?.addEventListener("click", async () => {
        await acceptIncomingCall();
    });

    document.getElementById("decline-call-btn")?.addEventListener("click", async () => {
        await declineIncomingCall("Chamada recusada.");
    });
}

function startRealtimeListeners() {
    if (state.listenersStarted) {
        return;
    }

    state.listenersStarted = true;

    onValue(ref(database, `${APP_ROOT}/channels`), async (snapshot) => {
        state.channels = snapshot.val() || {};
        await resetExpiredCallsIfNeeded();
        renderChannels();
        syncIncomingCallState();
        syncActiveCallState();
    });

    onValue(ref(database, `${APP_ROOT}/meta/forceLogoutAt`), (snapshot) => {
        const forceLogoutAt = snapshot.val() || 0;
        const createdAt = state.user?.createdAt || 0;

        if (forceLogoutAt && createdAt && forceLogoutAt > createdAt) {
            console.log("[auth] Logout forcado detectado");
            forceLogoutAndRedirect();
        }
    });
}

async function resetExpiredCallsIfNeeded() {
    const now = Date.now();
    const tasks = [];

    Object.values(state.channels).forEach((channel) => {
        if (channel?.status === "chamando" && channel?.timeoutAt && channel.timeoutAt < now) {
            tasks.push(resetChannel(channel.id, "Timeout automatico"));
        }
    });

    if (tasks.length) {
        await Promise.allSettled(tasks);
    }
}

function renderChannels() {
    const container = document.getElementById("channels-list");
    if (!container) {
        return;
    }

    container.innerHTML = CANAIS_FIXOS.map((canal) => {
        const channelState = state.channels[canal.id] || {};
        const status = channelState.status || "livre";
        const members = Object.values(channelState.members || {});
        const callButton = getCallButtonState(canal.id, status, members);

        return `
            <article class="channel-card">
                <div class="channel-header">
                    <div>
                        <h3>${canal.nome}</h3>
                        <p class="status-label">Status: ${getStatusLabel(status)}</p>
                    </div>
                    <span class="status-badge ${getStatusClass(status)}">${getStatusLabel(status)}</span>
                </div>
                <p class="channel-members">Responsavel: ${members.length ? members.map((member) => member.name).join(", ") : "Nenhum usuario conectado"}</p>
                ${renderMembers(canal.id, members)}
                <div class="channel-actions">
                    <button class="btn btn-primary" data-action="call-channel" data-channel-id="${canal.id}" ${callButton.disabled ? "disabled" : ""}>
                        ${callButton.label}
                    </button>
                </div>
            </article>
        `;
    }).join("");

    container.querySelectorAll('[data-action="call-channel"]').forEach((button) => {
        button.addEventListener("click", async () => {
            const channelId = button.dataset.channelId;
            const members = Object.values(state.channels[channelId]?.members || {}).filter((member) => member?.id && member.id !== state.user.id);
            if (!members.length) {
                return;
            }

            await startCall(channelId, members[0].id, members[0].name);
        });
    });

    updateHeaderState();
}

function renderMembers(channelId, members) {
    if (!members.length) {
        return `<div class="empty-members">Nenhum usuario conectado neste canal.</div>`;
    }

    return `
        <div class="members-list">
            ${members.map((member) => {
                const isSelf = member.id === state.user.id;
                return `
                    <div class="member-item">
                        <div class="member-meta">
                            <span class="member-name">${member.name}</span>
                            <span class="member-role">${isSelf ? "Seu canal de recepcao" : "Canal pronto para receber chamada"}</span>
                        </div>
                        ${channelId === state.user.homeChannelId ? "" : ""}
                    </div>
                `;
            }).join("")}
        </div>
    `;
}

async function startCall(channelId, targetId, targetName) {
    const channelRef = ref(database, `${APP_ROOT}/channels/${channelId}`);
    const callId = push(ref(database, `${APP_ROOT}/calls`)).key;
    const now = Date.now();

    console.log("[call] Tentando iniciar chamada", { channelId, targetId, targetName, callId });

    const transaction = await runTransaction(channelRef, (current) => {
        const channel = current || {};
        if ((channel.status && channel.status !== "livre") || !channel.members?.[targetId]) {
            return;
        }

        return {
            ...channel,
            status: "chamando",
            callerId: state.user.id,
            callerName: state.user.name,
            calleeId: targetId,
            calleeName: targetName,
            callId,
            ringStartedAt: now,
            timeoutAt: now + CALL_TIMEOUT_MS
        };
    });

    if (!transaction.committed) {
        alert("Este canal nao esta livre ou o operador saiu.");
        return;
    }

    state.currentCall = {
        channelId,
        callId,
        role: "caller",
        peerName: targetName
    };

    await set(ref(database, `${APP_ROOT}/calls/${callId}/meta`), {
        channelId,
        callerId: state.user.id,
        callerName: state.user.name,
        calleeId: targetId,
        calleeName: targetName,
        status: "chamando",
        createdAt: now
    });

    try {
        await setupRtcManager();
        await state.rtcManager.createOffer(callId);
        state.rtcManager.listenForAnswer(callId);
        state.rtcManager.listenForRemoteCandidates(callId, "caller");
        updateHeaderState("Chamando " + targetName + "...");
    } catch (error) {
        console.error("[call] Falha ao iniciar a chamada:", error);
        alert("Nao foi possivel iniciar a chamada. Verifique a permissao do microfone.");
        await endCall("Falha ao iniciar chamada.");
    }
}

function syncIncomingCallState() {
    const incomingChannel = state.channels[state.user.homeChannelId];

    if (!incomingChannel || incomingChannel.status !== "chamando" || incomingChannel.calleeId !== state.user.id) {
        hideIncomingCallModal();
        return;
    }

    if (state.incomingCall?.callId === incomingChannel.callId) {
        return;
    }

    state.incomingCall = {
        channelId: incomingChannel.id,
        callId: incomingChannel.callId,
        callerId: incomingChannel.callerId,
        callerName: incomingChannel.callerName
    };

    showIncomingCallModal(incomingChannel.callerName, incomingChannel.nome || findChannelName(incomingChannel.id));
}

function syncActiveCallState() {
    if (!state.currentCall) {
        return;
    }

    const channel = state.channels[state.currentCall.channelId];
    if (!channel || !channel.callId || channel.callId !== state.currentCall.callId) {
        endCall("A chamada foi finalizada.");
        return;
    }

    if (channel.status === "ocupado") {
        updateHeaderState(`Em chamada com ${state.currentCall.peerName}.`);
    }

    if (channel.status === "livre") {
        endCall("Canal liberado.");
    }
}

function showIncomingCallModal(callerName, channelName) {
    const modal = document.getElementById("incoming-call-modal");
    if (!modal) {
        return;
    }

    document.getElementById("incoming-call-title").textContent = `${callerName} esta chamando`;
    document.getElementById("incoming-call-description").textContent = `Canal ${channelName}. Deseja atender a chamada de audio?`;
    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    playRingtone();
}

function hideIncomingCallModal() {
    const modal = document.getElementById("incoming-call-modal");
    if (!modal) {
        return;
    }

    modal.classList.add("hidden");
    modal.setAttribute("aria-hidden", "true");
    state.incomingCall = null;
    stopRingtone();
}

async function acceptIncomingCall() {
    if (!state.incomingCall) {
        return;
    }

    const { channelId, callId, callerName } = state.incomingCall;
    const channelRef = ref(database, `${APP_ROOT}/channels/${channelId}`);

    const transaction = await runTransaction(channelRef, (current) => {
        if (!current || current.callId !== callId || current.status !== "chamando") {
            return;
        }

        return {
            ...current,
            status: "ocupado"
        };
    });

    if (!transaction.committed) {
        hideIncomingCallModal();
        return;
    }

    await update(ref(database, `${APP_ROOT}/calls/${callId}/meta`), {
        status: "ocupado",
        acceptedAt: Date.now()
    });

    state.currentCall = {
        channelId,
        callId,
        role: "callee",
        peerName: callerName
    };

    hideIncomingCallModal();

    try {
        await setupRtcManager();
        await state.rtcManager.acceptOfferAndCreateAnswer(callId);
        state.rtcManager.listenForRemoteCandidates(callId, "callee");
        updateHeaderState(`Em chamada com ${callerName}.`);
    } catch (error) {
        console.error("[call] Falha ao atender:", error);
        alert("Nao foi possivel atender. Verifique a permissao do microfone.");
        await endCall("Falha ao atender chamada.");
    }
}

async function declineIncomingCall(reason) {
    if (!state.incomingCall) {
        return;
    }

    const { channelId, callId } = state.incomingCall;
    hideIncomingCallModal();
    await update(ref(database, `${APP_ROOT}/calls/${callId}/meta`), {
        status: "recusada",
        declinedAt: Date.now(),
        reason
    });
    await resetChannel(channelId, reason);
}

async function setupRtcManager() {
    if (state.rtcManager) {
        return;
    }

    state.rtcManager = new WebRTCManager({
        sessionId: state.user.id,
        onRemoteStream: async (stream) => {
            await attachRemoteStream(stream);
        },
        onConnectionState: (connectionState) => {
            if (connectionState === "failed" || connectionState === "disconnected" || connectionState === "closed") {
                endCall(`Conexao ${connectionState}.`);
            }
        }
    });
}

async function endCall(reason = "Chamada encerrada.") {
    if (!state.currentCall) {
        updateHeaderState(reason);
        return;
    }

    const { channelId, callId } = state.currentCall;
    console.log("[call] Encerrando chamada", { channelId, callId, reason });

    if (state.rtcManager) {
        await state.rtcManager.close();
        state.rtcManager = null;
    }

    clearRemoteStream();
    hideIncomingCallModal();

    await update(ref(database, `${APP_ROOT}/calls/${callId}/meta`), {
        status: "encerrada",
        endedAt: Date.now(),
        reason
    }).catch(() => {});

    await remove(ref(database, `${APP_ROOT}/calls/${callId}`)).catch(() => {});
    await resetChannel(channelId, reason);

    state.currentCall = null;
    updateHeaderState(reason);
}

async function resetChannel(channelId, reason = "") {
    const channel = state.channels[channelId] || {};
    await update(ref(database, `${APP_ROOT}/channels/${channelId}`), {
        status: "livre",
        callerId: "",
        callerName: "",
        calleeId: "",
        calleeName: "",
        callId: "",
        ringStartedAt: null,
        timeoutAt: null,
        lastEvent: reason || ""
    });

    if (channel.callId) {
        await remove(ref(database, `${APP_ROOT}/calls/${channel.callId}`)).catch(() => {});
    }
}

function updateHeaderState(message) {
    const channelName = state.currentChannelId ? findChannelName(state.currentChannelId) : "Nenhum canal selecionado";
    document.getElementById("current-channel-name").textContent = channelName;
    document.getElementById("call-status-text").textContent = message || "Seu canal esta pronto para receber chamadas.";
    document.getElementById("connection-text").textContent = state.currentCall ? `Chamada ${state.currentCall.role === "caller" ? "iniciada por voce" : "recebida"} com ${state.currentCall.peerName}.` : "Nenhuma chamada em andamento.";

    const currentMembers = state.currentChannelId ? Object.values(state.channels[state.currentChannelId]?.members || {}) : [];
    document.getElementById("channel-members-count").textContent = `Usuarios no canal: ${currentMembers.length}`;
    document.getElementById("end-call-btn").disabled = !state.currentCall;
}

async function cleanupAndExit() {
    try {
        if (state.currentCall) {
            await endCall("Usuario saiu do sistema.");
        }

        if (state.currentChannelId) {
            await remove(ref(database, `${APP_ROOT}/channels/${state.currentChannelId}/members/${state.user.id}`)).catch(() => {});
        }

        await remove(ref(database, `${APP_ROOT}/presence/${state.user.id}`)).catch(() => {});
        await update(ref(database, `${APP_ROOT}/users/${state.user.id}`), {
            status: "offline",
            currentChannelId: ""
        }).catch(() => {});
    } finally {
        localStorage.removeItem(STORAGE_KEY);
        window.location.href = "./index.html";
    }
}

function forceLogoutAndRedirect() {
    localStorage.removeItem(STORAGE_KEY);
    window.location.href = "./index.html";
}

function handleBeforeUnload() {
    if (state.currentChannelId) {
        remove(ref(database, `${APP_ROOT}/channels/${state.currentChannelId}/members/${state.user.id}`)).catch(() => {});
    }

    if (state.currentCall) {
        resetChannel(state.currentCall.channelId, "Sessao encerrada").catch(() => {});
    }
}

function getCallButtonState(channelId, status, members) {
    if (channelId === state.user.homeChannelId) {
        return {
            disabled: true,
            label: "Meu canal"
        };
    }

    if (state.currentCall) {
        return {
            disabled: true,
            label: "Em chamada"
        };
    }

    if (!members.length) {
        return {
            disabled: true,
            label: "Sem operador"
        };
    }

    if (status === "ocupado") {
        return {
            disabled: true,
            label: "Canal ocupado"
        };
    }

    if (status === "chamando") {
        return {
            disabled: true,
            label: "Chamando"
        };
    }

    return {
        disabled: false,
        label: "Chamar canal"
    };
}

async function cleanupStaleSessions() {
    const [usersSnapshot, presenceSnapshot, channelsSnapshot] = await Promise.all([
        get(ref(database, `${APP_ROOT}/users`)),
        get(ref(database, `${APP_ROOT}/presence`)),
        get(ref(database, `${APP_ROOT}/channels`))
    ]);

    const users = usersSnapshot.val() || {};
    const presence = presenceSnapshot.val() || {};
    const channels = channelsSnapshot.val() || {};
    const cleanupTasks = [];

    Object.values(users).forEach((user) => {
        if (!user?.id || user.id === state.user?.id) {
            return;
        }

        const hasPresence = Boolean(presence[user.id]?.online);
        if (hasPresence) {
            return;
        }

        console.log("[presence] Limpando sessao offline:", user.name || user.id);
        cleanupTasks.push(cleanupUserSession(user, channels[user.homeChannelId || user.currentChannelId || ""]));
    });

    Object.entries(channels).forEach(([channelId, channel]) => {
        const members = channel?.members || {};
        Object.values(members).forEach((member) => {
            if (!member?.id || member.id === state.user?.id) {
                return;
            }

            if (presence[member.id]?.online) {
                return;
            }

            cleanupTasks.push(remove(ref(database, `${APP_ROOT}/channels/${channelId}/members/${member.id}`)).catch(() => {}));
        });
    });

    if (cleanupTasks.length) {
        await Promise.allSettled(cleanupTasks);
    }
}

async function cleanupUserSession(user, channelState = null) {
    const channelId = user.homeChannelId || user.currentChannelId || "";
    const tasks = [
        update(ref(database, `${APP_ROOT}/users/${user.id}`), {
            status: "offline",
            currentChannelId: ""
        }).catch(() => {}),
        remove(ref(database, `${APP_ROOT}/presence/${user.id}`)).catch(() => {})
    ];

    if (channelId) {
        tasks.push(remove(ref(database, `${APP_ROOT}/channels/${channelId}/members/${user.id}`)).catch(() => {}));

        const channel = channelState || state.channels[channelId];
        const userWasInCall =
            channel &&
            channel.callId &&
            (channel.callerId === user.id || channel.calleeId === user.id);

        if (userWasInCall) {
            tasks.push(resetChannel(channelId, "Sessao offline detectada").catch(() => {}));
        }
    }

    await Promise.allSettled(tasks);
}
