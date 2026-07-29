# Phoenix Auth Service

Authentication microservice for Project Phoenix (NestJS). Owns accounts, password
hashing, and access-token issuance.

## Endpoints

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/auth/register` | `{ email, username, password }` | `{ user, accessToken, expiresIn }` |
| `POST` | `/auth/login` | `{ email, password }` | `{ user, accessToken, expiresIn }` |
| `GET` | `/auth/me` | — (Bearer token) | `{ id, email, username, createdAt }` |
| `GET` | `/health` | — | `{ status, service, time }` |

## Design notes

- Passwords are hashed with bcrypt (cost 10). The login path runs a constant
  dummy compare on a missing user so response timing does not reveal which
  emails exist.
- Access tokens are short-lived (15 min) JWTs. Refresh-token rotation lives in
  the security design (`phoenix/docs/08-security-anticheat.md`) and is added next.
- `UsersRepository` is an interface; `InMemoryUsersRepository` backs tests and
  local runs, and a PostgreSQL implementation (`auth.users` in
  `phoenix/docs/02-database-schema.md`) drops in behind it unchanged.

## Run

```bash
cd phoenix/services/auth
npm install
npm test        # 7 unit tests, all green
npm run start   # http://localhost:4001
```
