import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { chatIdToPhone, ensureSettings, getStateInstance, phoneToChatId, pollOnce, sendMessage } from './api';
import type { Credentials } from './api';
import './App.css';

type Message = { id: string; chatId: string; text: string; time: number; mine: boolean; status?: 'sending' | 'sent' | 'error' };
type Chat = { chatId: string; title: string; lastTime: number };

const LS_CREDS = 'greenapi-chat:creds';
const LS_STATE = 'greenapi-chat:state';

function loadCreds(): Credentials | null {
  try {
    const raw = localStorage.getItem(LS_CREDS);
    return raw ? (JSON.parse(raw) as Credentials) : null;
  } catch {
    return null;
  }
}

function loadState(): { chats: Chat[]; messages: Message[] } {
  try {
    const raw = localStorage.getItem(LS_STATE);
    return raw ? JSON.parse(raw) : { chats: [], messages: [] };
  } catch {
    return { chats: [], messages: [] };
  }
}

const fmtTime = (t: number) => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

export default function App() {
  const [creds, setCreds] = useState<Credentials | null>(loadCreds);
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  const initial = useMemo(loadState, []);
  const [chats, setChats] = useState<Chat[]>(initial.chats);
  const [messages, setMessages] = useState<Message[]>(initial.messages);
  const [active, setActive] = useState<string | null>(initial.chats[0]?.chatId ?? null);
  const [draft, setDraft] = useState('');
  const [newPhone, setNewPhone] = useState('');
  const [pollError, setPollError] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(LS_STATE, JSON.stringify({ chats, messages }));
    } catch {
      /* хранилище недоступно, работаем в памяти */
    }
  }, [chats, messages]);

  const touchChat = useCallback((chatId: string, time: number, title?: string) => {
    setChats((prev) => {
      const found = prev.find((c) => c.chatId === chatId);
      const next = found
        ? prev.map((c) => (c.chatId === chatId ? { ...c, lastTime: Math.max(c.lastTime, time), title: c.title || title || chatIdToPhone(chatId) } : c))
        : [...prev, { chatId, title: title || chatIdToPhone(chatId), lastTime: time }];
      return next.sort((a, b) => b.lastTime - a.lastTime);
    });
  }, []);

  // Опрос очереди уведомлений, пока пользователь авторизован.
  useEffect(() => {
    if (!creds) return;
    let stopped = false;
    let failures = 0;
    const loop = async () => {
      while (!stopped) {
        try {
          const inc = await pollOnce(creds, 5);
          failures = 0;
          setPollError('');
          if (inc) {
            setMessages((prev) => (prev.some((m) => m.id === inc.idMessage) ? prev : [...prev, { id: inc.idMessage, chatId: inc.chatId, text: inc.text, time: inc.timestamp, mine: false }]));
            touchChat(inc.chatId, inc.timestamp, inc.senderName);
          }
        } catch (e) {
          failures++;
          setPollError((e as Error).message);
          await new Promise((r) => setTimeout(r, Math.min(15000, 1000 * failures)));
        }
      }
    };
    loop();
    return () => {
      stopped = true;
    };
  }, [creds, touchChat]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, active]);

  async function onLogin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const c: Credentials = {
      apiUrl: String(f.get('apiUrl') || '').trim() || 'https://api.green-api.com',
      idInstance: String(f.get('idInstance') || '').trim(),
      apiTokenInstance: String(f.get('apiTokenInstance') || '').trim(),
    };
    if (!c.idInstance || !c.apiTokenInstance) {
      setLoginError('Заполните idInstance и apiTokenInstance');
      return;
    }
    setLoggingIn(true);
    setLoginError('');
    try {
      const st = await getStateInstance(c);
      if (st.stateInstance !== 'authorized') {
        setLoginError(`Инстанс не авторизован (${st.stateInstance}). Отсканируйте QR в личном кабинете GREEN-API и попробуйте снова.`);
        return;
      }
      await ensureSettings(c).catch(() => {});
      try {
        localStorage.setItem(LS_CREDS, JSON.stringify(c));
      } catch {
        /* без хранилища тоже работает */
      }
      setCreds(c);
    } catch (err) {
      setLoginError((err as Error).message);
    } finally {
      setLoggingIn(false);
    }
  }

  function logout() {
    try {
      localStorage.removeItem(LS_CREDS);
    } catch {
      /* ignore */
    }
    setCreds(null);
  }

  function createChat(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const digits = newPhone.replace(/\D/g, '');
    if (digits.length < 10) return;
    const chatId = phoneToChatId(digits);
    touchChat(chatId, Date.now());
    setActive(chatId);
    setNewPhone('');
  }

  async function onSend(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!creds || !active) return;
    const text = draft.trim();
    if (!text) return;
    const tempId = `local-${Date.now()}`;
    const time = Date.now();
    setMessages((prev) => [...prev, { id: tempId, chatId: active, text, time, mine: true, status: 'sending' }]);
    setDraft('');
    touchChat(active, time);
    try {
      const r = await sendMessage(creds, active, text);
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, id: r.idMessage || tempId, status: 'sent' } : m)));
    } catch (err) {
      setMessages((prev) => prev.map((m) => (m.id === tempId ? { ...m, status: 'error' } : m)));
      setPollError((err as Error).message);
    }
  }

  if (!creds) {
    return (
      <div className="login">
        <form className="login__card" onSubmit={onLogin}>
          <h1>Вход</h1>
          <p className="muted">Данные инстанса из личного кабинета GREEN-API</p>
          <label>
            apiUrl
            <input name="apiUrl" placeholder="https://api.green-api.com" defaultValue="https://api.green-api.com" autoComplete="off" />
          </label>
          <label>
            idInstance
            <input name="idInstance" placeholder="1101000001" required autoComplete="off" />
          </label>
          <label>
            apiTokenInstance
            <input name="apiTokenInstance" type="password" placeholder="токен" required autoComplete="off" />
          </label>
          {loginError && <div className="error">{loginError}</div>}
          <button type="submit" disabled={loggingIn}>
            {loggingIn ? 'Проверяю…' : 'Войти'}
          </button>
        </form>
      </div>
    );
  }

  const activeChat = chats.find((c) => c.chatId === active) || null;
  const thread = messages.filter((m) => m.chatId === active);

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="sidebar__head">
          <div className="me">
            <div className="avatar avatar--me">Я</div>
            <div>
              <div className="me__title">Инстанс {creds.idInstance}</div>
              <div className="muted small">{pollError ? 'нет связи' : 'на связи'}</div>
            </div>
          </div>
          <button className="ghost" onClick={logout} title="Выйти">
            Выйти
          </button>
        </div>
        <form className="newchat" onSubmit={createChat}>
          <input value={newPhone} onChange={(e) => setNewPhone(e.target.value)} placeholder="Номер телефона, например 79991234567" inputMode="tel" />
          <button type="submit" disabled={newPhone.replace(/\D/g, '').length < 10}>
            Новый чат
          </button>
        </form>
        <div className="chats">
          {chats.length === 0 && <div className="empty small muted">Введите номер и создайте первый чат</div>}
          {chats.map((c) => {
            const last = [...messages].reverse().find((m) => m.chatId === c.chatId);
            return (
              <button key={c.chatId} className={'chat' + (c.chatId === active ? ' chat--active' : '')} onClick={() => setActive(c.chatId)}>
                <div className="avatar">{c.title.replace(/\D/g, '').slice(-2) || c.title.slice(0, 2)}</div>
                <div className="chat__body">
                  <div className="chat__row">
                    <span className="chat__title">{c.title}</span>
                    {last && <span className="chat__time">{fmtTime(last.time)}</span>}
                  </div>
                  <div className="chat__last">{last ? (last.mine ? 'Вы: ' : '') + last.text : 'нет сообщений'}</div>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <main className="thread">
        {!activeChat ? (
          <div className="thread__empty muted">Выберите чат или создайте новый</div>
        ) : (
          <>
            <header className="thread__head">
              <div className="avatar">{activeChat.title.replace(/\D/g, '').slice(-2) || activeChat.title.slice(0, 2)}</div>
              <div>
                <div className="thread__title">{activeChat.title}</div>
                <div className="muted small">{chatIdToPhone(activeChat.chatId)}</div>
              </div>
            </header>
            <div className="messages" ref={listRef}>
              {thread.map((m) => (
                <div key={m.id} className={'bubble' + (m.mine ? ' bubble--mine' : '')}>
                  <div className="bubble__text">{m.text}</div>
                  <div className="bubble__meta">
                    {fmtTime(m.time)}
                    {m.mine && (m.status === 'sending' ? ' · …' : m.status === 'error' ? ' · не отправлено' : ' · ✓')}
                  </div>
                </div>
              ))}
            </div>
            <form className="composer" onSubmit={onSend}>
              <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Сообщение" autoFocus />
              <button type="submit" disabled={!draft.trim()}>
                Отправить
              </button>
            </form>
          </>
        )}
        {pollError && <div className="toast">{pollError}</div>}
      </main>
    </div>
  );
}
