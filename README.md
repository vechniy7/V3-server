# Nexus License Server

Сервер активации для чита **Nexus** (тот же API, что у клиента: `POST /activate`).

## Логика ключей

| Тип | Префикс | Срок |
|-----|---------|------|
| Навсегда | `NXS-L-...` | без срока |
| 1 месяц | `NXS-M-...` | 30 дней с первой активации |

- Ключ **привязывается к HWID** при первом входе.
- Повторный запуск на **том же ПК** — успех (ключ не «сгорает» после 1 раза).
- Другой ПК с тем же ключом — отказ.
- Месячный ключ после истечения 30 дней — `Key expired.`

## Генерация 200 ключей

```bash
node generate-keys.js
```

Создаёт `keys.json`: **100** lifetime + **100** monthly.

## Запуск локально

```bash
npm install
node generate-keys.js   # если keys.json ещё нет
npm start
```

Проверка:

```bash
curl -X POST http://localhost:3000/activate -H "Content-Type: application/json" -d "{\"key\":\"NXS-L-....\",\"hwid\":\"testhwid\"}"
```

## Деплой (Render / VPS)

1. Залить папку `nexus-server-main` на сервер.
2. Выполнить `node generate-keys.js` один раз.
3. `npm start` (или `node server.js`).
4. URL в клиенте: `LicenseAuth.h` → `ACTIVATION_SERVER_URL`.

**Важно:** на Render бесплатный диск **сбрасывается** при перезапуске. Для продакшена используйте VPS, Render Disk или внешнюю БД.

## API

### `POST /activate`

Тело:

```json
{ "key": "NXS-L-XXXX-XXXX-XXXX-XXXX", "hwid": "..." }
```

Успех:

```json
{ "success": true, "message": "...", "type": "lifetime|monthly", "expiresAt": null }
```

Ошибки: `Invalid key.`, `Key is bound to another device.`, `Key expired.`
