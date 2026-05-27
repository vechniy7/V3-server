# Nexus License Server (V3)

## Готовые ключи (папка `keys/`)

| Файл | Тип | Срок | Кол-во |
|------|-----|------|--------|
| `lifetime.json` / `lifetime.txt` | Навсегда (`NXS-L-...`) | без срока | 500 |

Сервер **не генерирует** ключи при запуске — только читает эти файлы.

`.txt` — список ключей по одному на строку (для раздачи).  
`.json` — база с активациями (HWID, срок, статус).

## Render / Upstash

| Поле | Значение |
|------|----------|
| Build Command | `npm install` |
| Start Command | `npm start` |
| Publish Directory | пусто или `./` |

Состояние ключей хранится в **Upstash Redis**, поэтому после sleep/restart/redeploy ничего не сбрасывается.
Импорт lifetime ключей из `keys/lifetime.json` выполняется автоматически при старте (один раз).

## Пересоздать ключи (локально)

```bash
node generate-keys.js
```

Затем закоммитьте папку `keys/` и запушьте.

## API

`POST /activate` — `{ "key": "NXS-L-...", "hwid": "<64 hex sha256>", "client": "Nexus/2.1.0" }`

## Админский сброс HWID

`POST /admin/reset` — `{ "token": "<ADMIN_RESET_TOKEN>", "key": "NXS-L-..." }`

или заголовок:
`Authorization: Bearer <ADMIN_RESET_TOKEN>`

## ENV (Render)

- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`
- `ADMIN_RESET_TOKEN`
- `REDIS_PREFIX` (опционально)
