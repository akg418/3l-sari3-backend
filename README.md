# 3l sari3 - Backend

REST + WebSocket API for temporary chat channels. Node.js, Express, MongoDB and
`ws`, in a layered architecture.

> The React client that talks to this API lives in
> [3l-sari3-frontend](https://github.com/akg418/3l-sari3-frontend).

A channel exists for between 1 and 60 minutes. When its time is up the channel
and every message inside it are **deleted from MongoDB**, and everyone connected
is told in real time.

---

## Contents

- [Architecture](#architecture)
- [Design decisions](#design-decisions)
- [Requirements](#requirements)
- [Installation](#installation)
- [Environment variables](#environment-variables)
- [MongoDB setup](#mongodb-setup)
- [Running](#running)
- [REST API](#rest-api)
- [WebSocket protocol](#websocket-protocol)
- [Database structure](#database-structure)
- [Channel expiration](#channel-expiration)
- [Security](#security)
- [Testing](#testing)
- [Extending the system](#extending-the-system)

---

## Architecture

Each request travels in one direction through the layers, and each layer only
knows about the one below it:

```
HTTP request
  → route            (src/routes)        endpoint + middleware wiring
  → validator        (src/validators)    zod schema, rejects bad input early
  → controller       (src/controllers)   HTTP in, HTTP out. No business rules.
  → service          (src/services)      business rules and authorisation
  → repository       (src/repositories)  the only place that talks to mongoose
  → model            (src/models)        schema, indexes, constraints
  → MongoDB
```

WebSocket frames enter through a different door and land in the *same*
services, so a rule can never be enforced on one transport and forgotten on the
other:

```
WebSocket frame
  → wsServer         (src/websocket)     parse, budget, authorise
  → handler registry (src/websocket/handlers)
  → service          (src/services)      the same services the REST layer uses
```

Anything that happens *without* a request - a channel expiring - flows the
other way, through a domain event bus:

```
expiration job (src/jobs)
  → domain event  ("channel.expired")
  → realtime bridge (src/websocket/realtimeBridge.js)
  → rooms → connected clients
```

### Directory layout

```
src/
├── config/          environment parsing, database connection, logger
├── constants/       error codes, channel and message types, limits
├── controllers/     thin HTTP adapters
├── jobs/            channel expiration sweeper
├── middlewares/     auth, validation, error handling, rate limiting
├── models/          mongoose schemas and indexes
│   └── plugins/     UUID primary key plugin
├── repositories/    persistence boundary
├── routes/          route definitions
├── serializers/     the single definition of every API payload shape
├── services/        business logic
│   └── storage/     attachment storage driver (local disk today)
├── utils/           AppError, response envelope, ids, domain event bus
├── validators/      zod schemas and the authoritative field rules
├── websocket/       transport, rooms, connections, handlers, bridge, presence
├── app.js           Express application (no I/O, easy to mount in a test)
├── container.js     composition root - the whole object graph
└── server.js        process entry point and graceful shutdown
```

---

## Design decisions

**Layers, and business logic outside controllers.** A controller reads
`req.validated`, calls one service method and serialises the result. Everything
that could be wrong - membership, expiry, passwords - is decided in a service,
which is what lets the same rule serve both REST and WebSocket callers.

**Dependency injection at a composition root.** `container.js` builds every
repository, service and controller once and injects them downwards. Nothing
imports a singleton service, so a test can build the same graph with a fake
repository. `createApp(container)` does no I/O at all.

**Repository pattern.** Services never see a mongoose document. Repositories
return plain objects and translate driver specifics (such as duplicate-key
error 11000) into something the service layer can reason about.

**UUIDs as primary keys.** `_id` *is* the UUID string on every model. MongoDB
ObjectIds are never generated and never exposed, and there is no second unique
index to maintain. `toJSON` renames `_id` to `id`.

**UUIDv7 for messages.** Messages use a time-ordered UUID
(RFC 9562, `src/utils/id.js`). Two messages sent in the same millisecond share
a `createdAt`, so the id is what breaks the tie - and a random v4 id would
order them arbitrarily, showing the transcript out of order and corrupting
keyset pagination. Monotonic ids also keep inserts at the right-hand edge of
the `_id` index. Other collections have no natural order and use v4.

**Domain events (Observer).** The expiration job knows nothing about
WebSockets: it emits `channel.expired`, and `realtimeBridge.js` decides who
hears about it. New consumers - webhooks, metrics, push notifications - attach
without touching the producer.

**Handler registry (Registry/Command).** Each WebSocket event is one module
listed in `handlerRegistry.js`. Adding typing indicators or reactions means
adding a file, not growing an existing one.

**Rooms as the fan-out unit.** `RoomRegistry` maps a room name to the sockets
listening to it, and is deliberately separate from persisted membership: rooms
model "who is connected right now", the database models "who has joined".
Replacing it with a Redis-backed registry is the one change needed to run
several API instances.

**Channels are addressed by name.** A channel's name is already restricted to
characters that are safe in a URL path - no spaces, no slashes, nothing needing
escaping - so it *is* the public identifier and no slug has to be derived.
Every channel-addressed route takes a `:channelRef`, which the service resolves
as either a UUID or a name against the unique `nameKey`. Ids stay canonical
inside the system and on the WebSocket; they simply never appear in a URL.

**The per-user channel cap is enforced by the database.** Counting in
application code cannot hold under concurrency - every racing request reads the
same total and every one concludes it may proceed - and neither can re-counting
afterwards, because then every racer sees the same over-limit total and they
all back out. So each channel takes one of its owner's numbered *slots*, and a
unique index on `(createdBy, ownerSlot)` means two channels can never share
one. N slots is a hard ceiling of N channels, whatever the timing. The count
that runs first is only there to fail fast with a friendly message.

A slot is held until its channel is actually deleted, not merely until it is
due, so the count and the index always agree - the expiration job closes that
gap within a second.

**Membership is the only criterion for being in a channel.** Creating a
channel joins it, so it appears under "My Channels"; leaving one removes it.
The creator is the exception in the other direction: they *cannot* leave. A
channel with no owner present is a worse state than one you wait out - it is
theirs, it counts against their allowance, and for a private channel they are
the only one who knows the password. Since it deletes itself within the hour,
refusing keeps ownership and membership from ever diverging.

**Presence is transport state, membership is data.** Who has *joined* lives in
`channel_memberships`; who is *connected right now* is derived from the socket
registry. The roster reports both, so a member who closed their tab shows as
away rather than disappearing. Transitions are computed per user, not per
socket, so a second tab does not make someone "join" twice.

**Attachments upload before they send.** A file is uploaded to its channel
first, producing a pending `Attachment` row, and the message then references it
by id. That is what makes progress and previews possible, keeps the message
write small, and means an abandoned draft leaves a stray upload the sweeper
collects rather than a half-written message. Bytes live outside any served
directory and are only ever returned through an endpoint that checks channel
membership first - there is no public or signed URL for an attachment.

**Uploads are identified by their bytes.** The client's Content-Type is a hint;
the allowlist in `constants/attachments.js` matches magic bytes, so an
executable renamed `.png` or an SVG passed off as an image is rejected. It is an
allowlist rather than a blocklist, so an unforeseen type fails closed.

**One response envelope.** Every response carries `success`, `data` or `error`,
and `meta.serverTime`. That last field is what lets the browser measure its
clock offset on every single request, so countdowns never depend on the client
clock.

---

## Requirements

- Node.js 18.17 or newer (developed on Node 26)
- MongoDB 4.4 or newer, running locally or reachable by URI

---

## Installation

```bash
cd backend
npm install
cp .env.example .env
# then edit .env - at minimum, set JWT_SECRET
```

Generate a secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

The server validates its configuration at startup and refuses to boot with a
missing or malformed value, rather than failing later at request time.

---

## Environment variables

Every variable, with its default, lives in [`.env.example`](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `PORT` | `3005` | HTTP and WebSocket port |
| `MONGODB_URI` | - | **Required.** Connection string |
| `MONGODB_URI_TEST` | - | Optional. Database for the test suite |
| `JWT_SECRET` | - | **Required**, at least 32 characters |
| `JWT_EXPIRES_IN` | `1d` | Access token lifetime |
| `BCRYPT_SALT_ROUNDS` | `10` | Password hashing cost |
| `CORS_ORIGINS` | - | Comma-separated allowed browser origins |
| `CHANNEL_MIN_DURATION_MINUTES` | `1` | Shortest channel lifetime |
| `CHANNEL_MAX_DURATION_MINUTES` | `60` | Longest channel lifetime |
| `CHANNEL_MAX_ACTIVE_PER_USER` | `4` | How many live channels one user may own |
| `CHANNEL_EXPIRY_WARNING_SECONDS` | `60` | When the "about to be deleted" warning fires |
| `CHANNEL_SWEEP_INTERVAL_MS` | `1000` | How often the expiration job runs |
| `WS_PATH` | `/ws` | WebSocket endpoint path |
| `WS_AUTH_TIMEOUT_MS` | `10000` | Grace period to authenticate a new socket |
| `WS_HEARTBEAT_INTERVAL_MS` | `30000` | Ping interval for dead-socket detection |
| `WS_RATE_LIMIT_WINDOW_MS` / `WS_RATE_LIMIT_MAX_EVENTS` | `10000` / `60` | Per-socket inbound budget |
| `UPLOAD_DIR` | `./storage/uploads` | Where attachments are written. Never served statically |
| `UPLOAD_MAX_IMAGE_BYTES` | `5242880` | Per-image size limit |
| `UPLOAD_MAX_FILE_BYTES` | `10485760` | Per-file size limit |
| `UPLOAD_RATE_LIMIT_WINDOW_MS` / `UPLOAD_RATE_LIMIT_MAX_REQUESTS` | `60000` / `30` | Upload budget |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX_REQUESTS` | `60000` / `300` | General HTTP budget |
| `AUTH_RATE_LIMIT_WINDOW_MS` / `AUTH_RATE_LIMIT_MAX_REQUESTS` | `900000` / `20` | Credential endpoint budget |
| `LOG_LEVEL` | `info` | `error` \| `warn` \| `info` \| `debug` |
| `TRUST_PROXY` | `false` | Set to `true` behind a reverse proxy |

Secrets are only ever read from the environment. Nothing is hardcoded.

---

## MongoDB setup

No manual setup is needed beyond a running server - the application creates its
collections and **awaits index creation** on startup, because channel-name and
username uniqueness are enforced by the database, not only by application code.

macOS, with Homebrew:

```bash
brew tap mongodb/brew
brew install mongodb-community
brew services start mongodb-community
```

Docker:

```bash
docker run -d --name sari3-mongo -p 27017:27017 mongo:7
```

Verify:

```bash
curl http://localhost:3005/api/health
```

---

## Running

```bash
npm run dev     # watch mode
npm start       # production mode
npm test        # the full test suite
npm run test:coverage
```

`SIGINT`/`SIGTERM` shut down in order: stop the expiration job, close sockets,
close the HTTP server, disconnect from MongoDB.

---

## REST API

Base path: `/api`. All responses use one envelope.

**Success**

```json
{
  "success": true,
  "data": { "...": "..." },
  "meta": { "serverTime": "2026-09-10T16:18:00.000Z" }
}
```

**Error**

```json
{
  "success": false,
  "error": {
    "code": "CHANNEL_NOT_FOUND",
    "message": "This channel does not exist.",
    "details": [{ "field": "name", "message": "..." }]
  },
  "meta": { "serverTime": "...", "requestId": "..." }
}
```

`details` is present only for validation failures. `code` is stable and is what
the frontend maps to user-facing copy - server messages are never shown raw.

### Endpoints

`:channelRef` is a channel's **unique name** or its UUID - both resolve to the
same channel, which is what lets a link read `/channels/general`.

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | - | Liveness and MongoDB status |
| `POST` | `/api/auth/register` | - | Create an account, returns a token |
| `POST` | `/api/auth/login` | - | Sign in with username + password |
| `GET` | `/api/auth/me` | ✔ | The current user |
| `GET` | `/api/channels` | ✔ | A page of live channels, searchable and filterable |
| `POST` | `/api/channels` | ✔ | Create a channel |
| `GET` | `/api/channels/mine` | ✔ | Channels the caller has joined, each with `unreadCount`, plus their allowance |
| `GET` | `/api/channels/quota` | ✔ | How many channels the caller may still create |
| `GET` | `/api/channels/upload-constraints` | ✔ | Allowed attachment types and sizes |
| `GET` | `/api/channels/:channelRef` | ✔ | One channel |
| `GET` | `/api/channels/:channelRef/members` | ✔ | The roster with presence, members only |
| `POST` | `/api/channels/:channelRef/join` | ✔ | Join (password for private) |
| `POST` | `/api/channels/:channelRef/leave` | ✔ | Leave. The creator cannot; returns `CHANNEL_OWNER_CANNOT_LEAVE` |
| `GET` | `/api/channels/:channelRef/messages` | ✔ | Transcript, members only |
| `POST` | `/api/channels/:channelRef/attachments` | ✔ | Upload one file (multipart, field `file`) |
| `GET` | `/api/channels/:channelRef/attachments/:attachmentId` | ✔ | Download, members only |

Authenticate with `Authorization: Bearer <token>`.

### `POST /api/auth/register`

```json
{ "firstName": "John", "lastName": "Doe", "username": "john_doe", "password": "sup3r-secret" }
```

Username rules: at least 3 characters, must not start with a number, no spaces,
letters/digits/`_`/`.`/`-` only, unique (case-insensitively). Password: at
least 8 characters. `201` on success, with `{ user, token, expiresAt }`.

### `POST /api/channels`

```json
{ "name": "general", "type": "private", "password": "sup3r-channel-pw", "durationMinutes": 30 }
```

| Field | Rules |
|---|---|
| `name` | Optional. Omit it and the server generates `channel_483921`. Must not start with a number, no spaces, at most 20 characters, unique (case-insensitively) |
| `type` | `public` (default) or `private` |
| `password` | Required for `private`, 8-20 characters. Rejected for `public` |
| `durationMinutes` | Whole number, 1-60 |

`expiresAt` is computed by the server as `createdAt + durationMinutes`. A
client-supplied `expiresAt` is ignored, not trusted.

Response:

```json
{
  "id": "3f8a1c62-...",
  "name": "general",
  "type": "private",
  "isPrivate": true,
  "createdBy": { "id": "...", "username": "john" },
  "durationMinutes": 30,
  "createdAt": "...",
  "expiresAt": "...",
  "memberCount": 1,
  "isMember": true
}
```

The channel password - hashed or otherwise - is never part of any response.

### `GET /api/channels`

The directory. Newest first, paged, with optional search and filters:

| Query | Meaning |
|---|---|
| `search` | Substring of the channel name, case-insensitive |
| `owner` | Substring of the owner's username, case-insensitive |
| `type` | `public` or `private`; omit for both |
| `limit` | Page size, default 24, max 60 |
| `beforeCreatedAt`, `beforeId` | The keyset cursor from `pageInfo.nextCursor` |

```json
{
  "channels": [ ... ],
  "pageInfo": { "hasMore": true, "nextCursor": { "createdAt": "...", "id": "..." } }
}
```

Paging is keyset, not offset. Channels vanish as they expire, so an offset
would silently skip entries between one page and the next; a cursor stays
correct however much the set shifts underneath it.

Search terms are escaped before they reach MongoDB's `$regex`. Without that, a
caller could inject pattern syntax - `.*` to match everything, or a
catastrophically backtracking pattern aimed at the database.

A user may own at most `CHANNEL_MAX_ACTIVE_PER_USER` channels at once.
Exceeding it returns `409 CHANNEL_LIMIT_REACHED`. The cap counts only channels
the caller *created*; joining other people's channels is unlimited. An expired
channel frees its slot as soon as the sweeper deletes it.

### `GET /api/channels/:channelRef/messages`

Query: `limit` (default 50, max 100), `beforeCreatedAt` and `beforeId` for the
keyset cursor returned as `pageInfo.nextCursor`. Members only.

History is never filtered by when the reader joined: someone joining a channel
sees the conversation that led up to their arrival.

### `GET /api/channels/:channelRef/members`

```json
{
  "channelId": "3f8a1c62-...",
  "members": [
    {
      "id": "…", "username": "john", "displayName": "John Doe",
      "joinedAt": "…", "isOwner": true, "isOnline": true
    }
  ]
}
```

`isOnline` is live socket presence; membership is what the database records.
Members only - who is in a channel is not public information.

### `POST /api/channels/:channelRef/attachments`

`multipart/form-data` with a single `file` field. Returns the stored
attachment; its `url` is the authorised download path, which is the only way to
reach the bytes.

```json
{
  "id": "…", "kind": "image", "filename": "holiday.png",
  "mimeType": "image/png", "sizeBytes": 20481, "isImage": true,
  "url": "/api/channels/<channelId>/attachments/<id>"
}
```

Allowed: PNG, JPEG, GIF, WebP, PDF, ZIP, the OpenXML and legacy Office formats,
plain text, CSV, Markdown and JSON. The type is decided from the file's magic
bytes, not from the declared Content-Type. Images are capped at
`UPLOAD_MAX_IMAGE_BYTES` and everything else at `UPLOAD_MAX_FILE_BYTES`.

An upload is inert until a message references it via `attachmentIds`; unsent
uploads are swept after an hour.

### Error codes

`VALIDATION_ERROR`, `BAD_REQUEST`, `NOT_FOUND`, `RATE_LIMITED`,
`INTERNAL_ERROR`, `UNAUTHORIZED`, `INVALID_CREDENTIALS`, `TOKEN_EXPIRED`,
`TOKEN_INVALID`, `USERNAME_TAKEN`, `CHANNEL_NOT_FOUND`, `CHANNEL_NAME_TAKEN`,
`CHANNEL_EXPIRED`, `CHANNEL_PASSWORD_REQUIRED`, `CHANNEL_PASSWORD_INVALID`,
`CHANNEL_NOT_JOINED`, `CHANNEL_LIMIT_REACHED`, `CHANNEL_OWNER_CANNOT_LEAVE`,
`MESSAGE_TYPE_UNSUPPORTED`,
`ATTACHMENT_NOT_FOUND`, `ATTACHMENT_TOO_LARGE`, `ATTACHMENT_TYPE_UNSUPPORTED`,
`ATTACHMENT_LIMIT_REACHED`, `ATTACHMENT_ALREADY_USED`, `UPLOAD_FAILED`,
`WS_UNKNOWN_EVENT`, `WS_MALFORMED_FRAME`, `WS_NOT_AUTHENTICATED`.

---

## WebSocket protocol

Endpoint: `ws://localhost:3005/ws`. Every frame is JSON:

```json
{ "event": "message:send", "data": { "...": "..." }, "requestId": "r-42" }
```

`requestId` is optional. When present, the server echoes it on the reply, which
is how a client correlates a response with the call that caused it. Server
frames also carry `meta.serverTime`.

### Authentication

A new socket is anonymous. The server immediately sends `connection:ready`, and
the client must send `auth:authenticate` within `WS_AUTH_TIMEOUT_MS` or the
socket is closed with `4408`.

The token travels in a frame rather than in the URL, so it does not end up in
proxy or server access logs - and re-authenticating after a reconnect is an
ordinary message rather than a special case.

```
client → { "event": "auth:authenticate", "data": { "token": "<jwt>" } }
server → { "event": "auth:authenticated", "data": { "user": {...} } }
```

An invalid token yields an `error` frame and close code `4401`.

### Client → server

| Event | Payload | Notes |
|---|---|---|
| `auth:authenticate` | `{ token }` | Must be first |
| `ping` | `{}` | Answered with `pong` |
| `channel:join` | `{ channelId, password? }` | Joins **and** subscribes; replies with recent history and the roster |
| `channel:leave` | `{ channelId }` | Leaves and unsubscribes |
| `message:send` | `{ channelId, content?, attachmentIds?, clientMessageId? }` | Text, attachments, or both. `clientMessageId` is echoed on the ack |
| `channel:read` | `{ channelId }` | "I am looking at this" - moves the unread cutoff forward |

### Server → client

| Event | Payload | When |
|---|---|---|
| `connection:ready` | `{ connectionId, authTimeoutMs }` | On connect |
| `auth:authenticated` | `{ user, connectionId }` | Token accepted |
| `pong` | `null` | Reply to `ping` |
| `channel:created` | `{ channel }` | Anyone creates a channel |
| `channel:joined` | `{ channel, messages, pageInfo, members }` | Your join succeeded |
| `channel:left` | `{ channelId }` | Your leave succeeded |
| `channel:member_joined` / `channel:member_left` | `{ channelId, user }` | Someone else joined or left the channel |
| `channel:members` | `{ channelId, members }` | Full roster snapshot, whenever membership changes |
| `channel:presence` | `{ channelId, user, isOnline }` | One member connected or disconnected |
| `message:new` | `{ message }` | A message was posted in a channel you are in |
| `message:ack` | `{ messageId, channelId, clientMessageId }` | Your message was stored |
| `channel:activity` | `{ channelId, messageId, sender, createdAt }` | A message landed in a channel you belong to but are not watching. **No content** |
| `channel:read` | `{ channelId, readAt }` | Your read cutoff moved - sent to all your sessions |
| `channel:expiring` | `{ channelId, channelName, expiresAt, secondsRemaining, message }` | One minute left. **Sent once** |
| `channel:expired` | `{ channelId, channelName, reason, message }` | The channel and its messages are gone |
| `error` | `{ code, message, details? }` | Anything went wrong |

### Rooms

- `lobby` - every authenticated socket. Carries directory updates.
- `channel:<uuid>` - the sockets currently inside one channel.
- `user:<uuid>` - one person's sessions, for notices addressed to them.

`channel:expired` is delivered through the lobby, so every client updates its
lists and anyone sitting inside the channel is bounced out - exactly once per
client, whichever rooms they happen to be in.

### Every frame is validated

Nothing from a client is trusted: channel ids, user ids, permissions, message
bodies and expiry are all re-derived or re-checked server-side. The sender of a
message is always the authenticated socket's user, never a field in the
payload. Sockets also carry an inbound event budget; exceeding it closes the
connection with `4429`.

### Unread messages

A message reaches two audiences, deliberately differently:

- members **watching** the channel get `message:new` - the message itself;
- members who are connected but **looking elsewhere** get `channel:activity`,
  which carries no content, only enough to move a badge. They are entitled to
  the content, but sending it to a client that is not showing the channel is
  wasted bandwidth.

The cutoff is `ChannelMembership.lastReadAt`, and it only ever moves forward,
so a replayed or out-of-order acknowledgement cannot make read messages unread
again. Opening a channel marks it read server-side, and the acknowledgement is
broadcast to *all* of that user's sessions - so reading in one tab clears the
badge in another. A member's own messages never count as unread, and neither
does anything from before they joined.

### Presence

Membership and presence are separate facts, and both are reported.

- `channel:members` carries the **full roster** and is sent on join and on
  every membership change. A snapshot cannot drift out of step with the server,
  which a long stream of deltas eventually can.
- `channel:presence` is a **delta** for a single person coming or going. These
  are frequent and need no database read, so a delta is the right shape.

Presence is computed per user, not per socket: someone is online from their
first socket in a channel and offline only when their last one goes. A closed
tab, a sleeping laptop or a dropped connection all resolve correctly, because
the transition is settled when the socket closes rather than trusting clients
to announce their own departure.

### Liveness

The server pings every socket on `WS_HEARTBEAT_INTERVAL_MS` and terminates any
that missed the previous round, which stops half-open connections from leaking
room membership. Browsers cannot send protocol pings, so the client sends an
application-level `ping` too.

---

## Database structure

### `users`

| Field | Type | Notes |
|---|---|---|
| `_id` | UUID string | Primary key, public id |
| `firstName`, `lastName` | string | |
| `username` | string | As typed, for display |
| `usernameKey` | string | Lower-cased. **Unique index** |
| `passwordHash` | string | bcrypt. `select: false` |
| `createdAt`, `updatedAt` | Date | |

### `channels`

| Field | Type | Notes |
|---|---|---|
| `_id` | UUID string | Primary key, public id |
| `name` | string | As typed |
| `nameKey` | string | Lower-cased. **Unique index** |
| `type` | `public` \| `private` | |
| `passwordHash` | string \| null | Private channels only. `select: false` |
| `createdBy`, `createdByUsername` | string | Denormalised name to avoid a join |
| `durationMinutes` | number | 1-60 |
| `ownerSlot` | number | Which of its owner's allowance slots it holds. Unique per owner |
| `createdAt` | Date | Declared explicitly, so `expiresAt` is derived from the same instant |
| `expiresAt` | Date | **TTL index** |
| `reminderSentAt` | Date \| null | Idempotency guard for the one-minute warning |

### `messages`

| Field | Type | Notes |
|---|---|---|
| `_id` | UUID **v7** string | Time-ordered, see [Design decisions](#design-decisions) |
| `channelId` | UUID string | |
| `senderId`, `senderUsername` | string | |
| `messageType` | string | `text` today; `image`/`file`/`audio`/`video` are already valid values |
| `content` | string | Body, or a caption for an attachment message |
| `attachments` | array | Empty for now, modelled for later |
| `metadata` | object | Free-form, for future per-type data |
| `createdAt` | Date | |
| `expiresAt` | Date | Mirrors the channel. **TTL index** |

### `attachments`

| Field | Type | Notes |
|---|---|---|
| `_id` | UUID string | Also the storage key |
| `channelId` | UUID string | Scopes both authorisation and storage |
| `uploaderId` | UUID string | Only this user may attach it to a message |
| `messageId` | UUID string \| null | Null until a message claims it |
| `kind` | `image` \| `file` | Decides inline rendering versus download |
| `mimeType` | string | Resolved from the bytes, never the client's claim |
| `filename` | string | Sanitised original name, for display and downloads |
| `sizeBytes` | number | |
| `storageScope`, `storageKey` | string | Never serialised to a client |
| `expiresAt` | Date | Mirrors the channel. **TTL index** |

### `channel_memberships`

| Field | Type | Notes |
|---|---|---|
| `_id` | UUID string | |
| `channelId`, `userId` | UUID string | **Unique compound index** |
| `joinedAt` | Date | |
| `lastReadAt` | Date \| null | Unread cutoff. Null means "not opened since joining", so `joinedAt` is used |
| `expiresAt` | Date | **TTL index** |

Membership lives in its own collection rather than as an array on the channel:
it keeps "my channels" and every authorisation check a single indexed lookup,
and leaves room for per-member state - roles, read receipts, mutes.

### Indexes

| Collection | Index | Purpose |
|---|---|---|
| `users` | `usernameKey` unique | Username uniqueness, login lookup |
| `channels` | `nameKey` unique | Channel name uniqueness at database level |
| `channels` | `createdBy, ownerSlot` unique (partial) | The per-user channel cap, enforced by the database |
| `channels` | `expiresAt` TTL | Sweeper scan **and** deletion safety net |
| `channels` | `createdAt desc, _id desc` | Directory listing and its keyset cursor |
| `messages` | `channelId, createdAt desc, _id desc` | History reads and cursor pagination |
| `messages` | `expiresAt` TTL | Safety net |
| `channel_memberships` | `channelId, userId` unique | Idempotent joins, authorisation |
| `channel_memberships` | `userId` | "My channels" |
| `channel_memberships` | `expiresAt` TTL | Safety net |
| `attachments` | `channelId, createdAt desc` | Per-channel listing |
| `attachments` | `messageId` | Claim lookups and the orphan sweep |
| `attachments` | `expiresAt` TTL | Safety net |

---

## Channel expiration

The server is the only authority on channel lifetime. Two mechanisms work
together.

**1. The sweeper** (`src/jobs/channelExpiration.job.js`), every second:

- Channels that have crossed into the warning window and have no
  `reminderSentAt` are *claimed* with an atomic
  `updateOne({ _id, reminderSentAt: null }, ...)`. Only the writer that wins
  the claim announces `channel.expiring`, so the warning fires **exactly once**
  even with several API instances sweeping concurrently - and the persisted
  flag stops it repeating on the next tick.
- Channels past `expiresAt` are hard-deleted along with their messages and
  memberships, and `channel.expired` is announced. Deletion happens whether or
  not anyone is connected.

**2. TTL indexes** on `channels.expiresAt`, `messages.expiresAt` and
`channel_memberships.expiresAt`, each with a 60-second grace period. The
sweeper normally wins by a wide margin, which is what makes the cascade and the
realtime events happen; TTL is the safety net for when no instance is running
at all. Messages carry their own `expiresAt`, copied from the channel, so they
can never outlive it even in that path.

Deleting a channel takes its messages, memberships, attachment records **and
the stored files** with it - attachments are grouped in a directory per
channel, so the bytes go in a single removal.

Two smaller sweeps run alongside: uploads that were never sent are collected
after an hour, and at startup any storage directory whose channel no longer
exists is removed - which is what keeps the guarantee true across a restart
where MongoDB's TTL monitor did the deleting.

There is no soft delete anywhere. An expired channel is also unreachable
*before* the sweeper gets to it: every read path goes through
`getActiveChannelOrFail`, so a client acting on a stale directory gets
`CHANNEL_EXPIRED` rather than access.

---

## Security

| Concern | How it is handled |
|---|---|
| Password storage | bcrypt, configurable cost. `passwordHash` is `select: false` |
| Password exposure | No response contains a password or a hash - asserted in tests |
| Channel passwords | Hashed with the same service, never returned, verified server-side only |
| User enumeration | Wrong password and unknown user return an identical error, and a dummy hash is compared so timing does not differ either |
| Token handling | JWT, verified on every request; the user is re-read from the database because a token proves identity, never current state |
| Authorisation | Enforced in services: only members post or read, expired channels are unreachable, the sender is always the authenticated user |
| Input validation | zod at the boundary; handlers read only `req.validated`, so unvalidated client fields cannot reach a service |
| Message content | Normalised and stripped of control characters, length-capped, stored as plain text and never interpreted as markup |
| Upload types | Allowlist matched against **magic bytes**; the declared Content-Type is honoured only when the bytes agree. SVG, HTML and scripts are not on the list, so they fail closed |
| Upload size | Enforced by multer as an outer bound, then per kind once the type is known |
| Stored files | Written outside any served directory, named by a server-generated UUID, mode `0600`. The client's filename is display text only |
| Serving files | Only through an endpoint that checks channel membership; `nosniff`, a restrictive CSP, `inline` for images and `attachment` for everything else. No public or signed URL exists |
| Attachment ownership | An upload can be attached only by the user who uploaded it, to the channel it was uploaded to, exactly once |
| Channel cap | Enforced server-side with a post-insert re-check, so parallel requests cannot exceed it |
| WebSocket origin | Checked during the HTTP upgrade, because browsers do not apply CORS to WebSockets |
| CORS | Explicit allowlist from `CORS_ORIGINS` |
| Rate limiting | Tight budget on credential endpoints, a general HTTP budget, and a per-socket event budget |
| Error leakage | Unexpected errors are logged in full and returned as an opaque `INTERNAL_ERROR`; stack traces and driver messages never reach a client |
| Headers | `helmet`, `x-powered-by` disabled |
| Secrets | Environment only, validated at startup, never hardcoded |

---

## Testing

```bash
npm test
npm run test:coverage
```

The suite prefers `MONGODB_URI_TEST` if set, otherwise starts an in-memory
MongoDB, otherwise falls back to a local `mongod`.

```
tests/
├── integration/
│   ├── auth.test.js           registration, username rules, login, tokens
│   ├── channels.test.js       creation, name rules, uniqueness, joining, listing
│   ├── channelDirectory.test.js  search, owner and type filters, keyset paging
│   ├── channelLimit.test.js   the four-channel cap, including the parallel race
│   ├── privateAccess.test.js  the password gate and the owner rule
│   ├── members.test.js        the roster and live presence over real sockets
│   ├── unread.test.js         unread counts, activity nudges, read cutoffs
│   ├── attachments.test.js    uploads, type sniffing, authorisation, cleanup
│   ├── messages.test.js       sending, authorisation, persistence, pagination
│   ├── expiration.test.js     the one-minute reminder, deletion, cascade, indexes
│   └── websocket.test.js      the live protocol, end to end over a real socket
├── unit/
│   ├── rules.test.js            the validation rules themselves
│   ├── attachmentTypes.test.js  magic-byte identification and its refusals
│   ├── id.test.js               UUID generation and v7 monotonicity
│   └── connection.test.js       socket state and the inbound budget
└── helpers/
```

Covered, among other things: duplicate and invalid usernames; login success and
failure; public and private channel creation; duplicate and malformed channel
names; database-level name uniqueness; invalid private passwords; invalid
durations; joining public and private channels with the right and wrong
password; refusing to join an expired channel; members sending messages and
non-members being refused; persistence and UUID generation; channels expiring,
being deleted with their messages, broadcasting the expiry, and triggering the
one-minute reminder exactly once.

Also covered: the four-channel cap and the concurrent requests that try to slip
past it; the owner's exemption from their own channel's password; the roster's
online/away distinction across multiple tabs and abrupt disconnections; and,
for attachments, executables renamed as images, SVG and HTML being refused,
size limits, filename sanitisation, cross-channel and non-member access to
files, single-use enforcement, and the cascade that removes files when a
channel expires.

---

## Extending the system

The structure is meant to absorb these without a rewrite:

| Feature | Where the work goes |
|---|---|
| Audio and video messages | Add the MIME types to the allowlist in `constants/attachments.js`; the upload, storage and message paths already handle them |
| S3 or GCS storage | Implement the six methods of `services/storage/LocalFileStorage.js` and select it in `createStorage` |
| Image thumbnails or dimensions | Populate `Attachment.metadata` at upload time; the serializer passes it straight through |
| Reactions, read receipts, roles | New collection or fields on `channel_memberships` + a handler module |
| Typing indicators | One handler module and one room broadcast, alongside the existing presence events |
| Message editing and deletion | A service method plus a new WebSocket event; ids are already stable |
| Notifications, webhooks, analytics | Subscribe to the existing domain events |
| Search, pagination | The message index and cursor pagination are already in place |
| Horizontal scaling | Replace `RoomRegistry` with a Redis-backed adapter. The sweeper is already safe to run on several instances |
