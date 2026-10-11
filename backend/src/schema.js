/**
 * Схема базы PostgreSQL. Миграции применяются по порядку при старте сервера
 * и записываются в `schema_version`. Уже применённые миграции НЕ редактируем:
 * любое изменение схемы добавляется новой миграцией в конец списка.
 *
 * Деньги и остатки хранятся целыми числами (тенге, штуки). CHECK-условия
 * не дают уйти в минус, даже если ошибка в коде или два сервера пишут одновременно.
 */
export const MIGRATIONS = [
  {
    version: 1,
    sql: `
CREATE TABLE users (
  iin         text PRIMARY KEY CHECK (iin ~ '^[0-9]{12}$'),
  name        text NOT NULL,
  unit        text NOT NULL,
  balance     integer NOT NULL CHECK (balance >= 0),
  pin_salt    text NOT NULL,
  pin_hash    text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE products (
  id        text PRIMARY KEY,
  pos       integer NOT NULL,
  name_ru   text NOT NULL,
  name_kk   text NOT NULL,
  category  text NOT NULL,
  price     integer NOT NULL CHECK (price >= 0),
  icon      text NOT NULL,
  stock     integer NOT NULL CHECK (stock >= 0)
);

CREATE TABLE favorites (
  iin         text NOT NULL REFERENCES users(iin) ON DELETE CASCADE,
  product_id  text NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  PRIMARY KEY (iin, product_id)
);

CREATE TABLE orders (
  id            uuid PRIMARY KEY,
  seq           integer GENERATED ALWAYS AS IDENTITY, -- строгий порядок создания (время может совпасть)
  iin           text NOT NULL REFERENCES users(iin),
  request_id    text,
  code          text NOT NULL,
  status        text NOT NULL CHECK (status IN ('ready', 'picked_up', 'cancelled')),
  total         integer NOT NULL CHECK (total >= 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  picked_up_at  timestamptz,
  cancelled_at  timestamptz
);
-- Повтор того же запроса (обрыв связи) не создаёт второй заказ, даже при гонке двух серверов.
CREATE UNIQUE INDEX orders_request_uq ON orders (iin, request_id) WHERE request_id IS NOT NULL;
-- Среди ожидающих выдачи коды не повторяются.
CREATE UNIQUE INDEX orders_ready_code_uq ON orders (code) WHERE status = 'ready';
CREATE INDEX orders_iin_seq_ix ON orders (iin, seq DESC);
CREATE INDEX orders_status_seq_ix ON orders (status, seq DESC);

CREATE TABLE order_items (
  order_id    uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  pos         integer NOT NULL,
  product_id  text NOT NULL,
  name_ru     text NOT NULL,
  name_kk     text NOT NULL,
  price       integer NOT NULL,
  qty         integer NOT NULL CHECK (qty > 0),
  PRIMARY KEY (order_id, pos)
);

-- Журнал движения денег. Только добавляется, строки не меняются.
CREATE TABLE ledger (
  id        integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  t         timestamptz NOT NULL DEFAULT now(),
  iin       text NOT NULL,
  type      text NOT NULL,
  amount    integer NOT NULL,
  balance   integer NOT NULL,
  order_id  uuid,
  note      text
);
CREATE INDEX ledger_iin_id_ix ON ledger (iin, id DESC);

-- Эталоны лица. descriptor зашифрован (v1:...) или, без ключа, обычный JSON.
CREATE TABLE face_templates (
  iin         text NOT NULL REFERENCES users(iin) ON DELETE CASCADE,
  pos         integer NOT NULL,
  descriptor  text NOT NULL,
  PRIMARY KEY (iin, pos)
);

-- Счётчики неудач и блокировки. Строка может быть и для неизвестного ИИН
-- (иначе по ответам сервера можно было бы узнать, какие ИИН существуют).
CREATE TABLE security (
  iin            text PRIMARY KEY,
  pin_fails      integer NOT NULL DEFAULT 0,
  face_fails     integer NOT NULL DEFAULT 0,
  strikes        integer NOT NULL DEFAULT 0,
  locked_at      timestamptz,
  locked_reason  text,
  locked_until   timestamptz
);

-- Токены хранятся только в виде хэша SHA-256: утечка базы не даёт готовых сеансов.
CREATE TABLE pending_logins (
  token_hash  text PRIMARY KEY,
  iin         text NOT NULL,
  expires_at  timestamptz NOT NULL,
  busy        boolean NOT NULL DEFAULT false
);

CREATE TABLE sessions (
  token_hash  text PRIMARY KEY,
  iin         text NOT NULL REFERENCES users(iin) ON DELETE CASCADE,
  expires_at  timestamptz NOT NULL
);
CREATE INDEX sessions_expires_ix ON sessions (expires_at);
CREATE INDEX pending_expires_ix ON pending_logins (expires_at);
`,
  },
];
