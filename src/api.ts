// Тонкая обёртка над HTTP API GREEN-API: отправка текста и получение входящих через
// очередь уведомлений (ReceiveNotification + DeleteNotification).

export type Credentials = {
  apiUrl: string;
  idInstance: string;
  apiTokenInstance: string;
};

export type IncomingText = {
  chatId: string;
  text: string;
  idMessage: string;
  timestamp: number;
  senderName?: string;
};

const trimSlash = (s: string) => s.replace(/\/+$/, '');

// Формат адреса: {apiUrl}/waInstance{id}/{method}/{token}[/{extraPath}][?query]
function url(c: Credentials, method: string, extraPath = '', query = '') {
  return `${trimSlash(c.apiUrl)}/waInstance${c.idInstance}/${method}/${c.apiTokenInstance}${extraPath}${query}`;
}

async function call<T>(c: Credentials, method: string, init?: RequestInit, opts: { extraPath?: string; query?: string } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url(c, method, opts.extraPath, opts.query), init);
  } catch {
    throw new Error('Нет связи с GREEN-API: проверьте apiUrl и подключение к сети');
  }
  if (res.status === 401 || res.status === 403) throw new Error('GREEN-API отклонил запрос: проверьте idInstance и apiTokenInstance');
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${method}: HTTP ${res.status}${body ? ' ' + body.slice(0, 200) : ''}`);
  }
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

// Номер телефона в chatId: только цифры, суффикс @c.us для личного чата.
export function phoneToChatId(phone: string) {
  const digits = phone.replace(/\D/g, '');
  return `${digits}@c.us`;
}

export function chatIdToPhone(chatId: string) {
  return '+' + chatId.replace(/@.*$/, '');
}

export async function getStateInstance(c: Credentials) {
  return call<{ stateInstance: string }>(c, 'getStateInstance');
}

// Чтобы уведомления копились в очереди, у инстанса должен быть включён incomingWebhook
// и пустой webhookUrl. Ставим один раз при входе.
export async function ensureSettings(c: Credentials) {
  const s = await call<{ incomingWebhook?: string; webhookUrl?: string }>(c, 'getSettings');
  if (s?.incomingWebhook === 'yes' && !s?.webhookUrl) return;
  await call(c, 'setSettings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookUrl: '', incomingWebhook: 'yes', outgoingMessageWebhook: 'no', outgoingAPIMessageWebhook: 'no' }),
  });
}

export async function sendMessage(c: Credentials, chatId: string, message: string) {
  return call<{ idMessage: string }>(c, 'sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId, message }),
  });
}

type Notification = {
  receiptId: number;
  body: {
    typeWebhook: string;
    timestamp?: number;
    idMessage?: string;
    senderData?: { chatId?: string; sender?: string; senderName?: string };
    messageData?: {
      typeMessage?: string;
      textMessageData?: { textMessage?: string };
      extendedTextMessageData?: { text?: string };
    };
  };
};

// Один шаг опроса очереди: забрать уведомление, удалить его, вернуть текст, если это
// входящее текстовое сообщение. Сервер держит соединение до receiveTimeout секунд.
export async function pollOnce(c: Credentials, receiveTimeout = 5): Promise<IncomingText | null> {
  const n = await call<Notification | null>(c, 'receiveNotification', undefined, { query: `?receiveTimeout=${receiveTimeout}` });
  if (!n) return null;
  try {
    const b = n.body;
    if (b.typeWebhook === 'incomingMessageReceived') {
      const text = b.messageData?.textMessageData?.textMessage ?? b.messageData?.extendedTextMessageData?.text;
      if (text && b.senderData?.chatId) {
        return {
          chatId: b.senderData.chatId,
          text,
          idMessage: b.idMessage || String(n.receiptId),
          timestamp: (b.timestamp || Math.floor(Date.now() / 1000)) * 1000,
          senderName: b.senderData.senderName,
        };
      }
    }
    return null;
  } finally {
    await call(c, 'deleteNotification', { method: 'DELETE' }, { extraPath: `/${n.receiptId}` }).catch(() => {});
  }
}
