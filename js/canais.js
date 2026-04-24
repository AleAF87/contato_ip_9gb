export const CANAIS_FIXOS = [
    { id: "ch-em-adm", nome: "Ch EM Adm" },
    { id: "b3-dejem", nome: "B/3 DEJEM" },
    { id: "b3-ch-aux", nome: "B/3 Ch Aux" },
    { id: "b5", nome: "B/5" }
];

export const STATUS_LABELS = {
    livre: "Livre",
    chamando: "Chamando",
    ocupado: "Ocupado"
};

export function getChannelTemplate() {
    return CANAIS_FIXOS.reduce((acc, canal) => {
        acc[canal.id] = {
            id: canal.id,
            nome: canal.nome,
            status: "livre",
            callerId: "",
            callerName: "",
            calleeId: "",
            calleeName: "",
            callId: "",
            updatedAt: 0
        };
        return acc;
    }, {});
}

export function getStatusLabel(status) {
    return STATUS_LABELS[status] || "Livre";
}

export function getStatusClass(status) {
    return `status-${status || "livre"}`;
}

export function findChannelName(channelId) {
    return CANAIS_FIXOS.find((canal) => canal.id === channelId)?.nome || "Canal";
}
