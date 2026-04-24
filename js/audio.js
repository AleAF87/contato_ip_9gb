let ringtone = null;
let remoteAudio = null;

export function setupAudio() {
    ringtone = new Audio("./assets/toque.mp3");
    ringtone.loop = true;
    ringtone.preload = "auto";

    remoteAudio = document.getElementById("remote-audio") || null;
}

export async function playRingtone() {
    if (!ringtone) {
        return;
    }

    try {
        ringtone.currentTime = 0;
        await ringtone.play();
        console.log("[audio] Toque iniciado");
    } catch (error) {
        console.warn("[audio] Falha ao tocar o toque:", error);
    }
}

export function stopRingtone() {
    if (!ringtone) {
        return;
    }

    ringtone.pause();
    ringtone.currentTime = 0;
    console.log("[audio] Toque parado");
}

export async function attachRemoteStream(stream) {
    if (!remoteAudio) {
        return;
    }

    remoteAudio.srcObject = stream;

    try {
        await remoteAudio.play();
        console.log("[audio] Audio remoto reproduzindo");
    } catch (error) {
        console.warn("[audio] Nao foi possivel reproduzir o audio remoto automaticamente:", error);
    }
}

export function clearRemoteStream() {
    if (remoteAudio) {
        remoteAudio.srcObject = null;
    }
}
