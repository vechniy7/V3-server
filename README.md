# Nexus License Server (V3)

Сервер активации для **Nexus**: `POST /activate` с `{ "key", "hwid" }`.

## Ключи

| Тип | Формат | Срок |
|-----|--------|------|
| Навсегда | `NXS-L-XXXX-XXXX-XXXX-XXXX` | без срока |
| 1 месяц | `NXS-M-XXXX-XXXX-XXXX-XXXX` | 30 дней с первой активации |

- Привязка к **HWID** при первом входе.
- Повторный запуск на **том же ПК** — ключ остаётся рабочим.
- Другой ПК — отказ.

---

## Render.com (пошагово)

У Render **два поля** — Build и Start. Вводить `&&` вручную не обязательно.

### Вариант A — проще всего (рекомендуется)

| Поле | Значение |
|------|----------|
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |

При **первом запуске** сервер сам создаст `keys.json` (100 + 100 ключей), если файла ещё нет.

Файлы со списком ключей (на диске инстанса):

- `keys-lifetime.txt`
- `keys-monthly.txt`

Скачать их можно через **Render Shell** (вкладка Shell у сервиса) или один раз при деплое посмотреть логи.

### Вариант B — ключи уже на этапе сборки

| Поле | Значение |
|------|----------|
| **Build Command** | `npm run build` |
| **Start Command** | `npm start` |

`npm run build` = `npm install` + создание `keys.json` (если его ещё нет).

### Чтобы ключи не сбрасывались при перезапуске

На Render диск **временный**. Подключите **Persistent Disk** (платно) и переменную:

| Key | Value |
|-----|-------|
| `KEYS_FILE` | `/var/data/keys.json` |

Mount path диска: `/var/data`

Тогда ключи и активации сохраняются между рестартами.

---

## Локально

```bash
npm install
npm start
```

Или только сгенерировать ключи:

```bash
npm run generate-keys
```

Принудительно пересоздать ключи (осторожно — старые перестанут работать):

```bash
set FORCE_KEYS=1
npm run generate-keys
```

## API

`POST /activate` — тело `{ "key": "NXS-L-...", "hwid": "..." }`

Успех: `{ "success": true, "type": "lifetime|monthly", "expiresAt": null }`
