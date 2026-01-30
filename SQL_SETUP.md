# SQL (PostgreSQL) setup для anonymous-messenger

Проект умеет работать **без БД** (история в памяти), но если включить SQL — история сообщений будет сохраняться и не пропадёт после рестарта сервера.

## 1) Установить PostgreSQL на Ubuntu (на сервере)

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
```

Проверка:
```bash
sudo systemctl status postgresql
```

## 2) Создать базу и пользователя

Зайди в postgres:
```bash
sudo -u postgres psql
```

Внутри psql выполни (замени пароль):
```sql
CREATE DATABASE anonymous_messenger;
CREATE USER anonymous_user WITH ENCRYPTED PASSWORD 'СЮДА_ПАРОЛЬ';
GRANT ALL PRIVILEGES ON DATABASE anonymous_messenger TO anonymous_user;
\q
```

## 3) Прописать DATABASE_URL в .env проекта

Создай файл:
`/var/www/anonymous-messenger/server/.env`

Командой:
```bash
sudo nano /var/www/anonymous-messenger/server/.env
```

Вставь:
```env
DATABASE_URL=postgres://anonymous_user:СЮДА_ПАРОЛЬ@127.0.0.1:5432/anonymous_messenger
# Если у тебя управляемый Postgres с SSL, добавь:
# PGSSLMODE=require
```

Сохрани: Ctrl+O → Enter, выйти: Ctrl+X

## 4) Установить зависимости и перезапустить сервер

```bash
cd /var/www/anonymous-messenger/server
npm ci || npm install
pm2 restart anonymous-server
pm2 logs anonymous-server --lines 50
```

В логах должно появиться:
`✅ SQL подключён: таблицы готовы`

## 5) Проверка

Открой сайт, зайди в комнату, отправь пару сообщений.
Потом перезапусти сервер и проверь, что история сохранилась:

```bash
pm2 restart anonymous-server
```

## Примечания

- Таблица создаётся автоматически при старте сервера (CREATE TABLE IF NOT EXISTS).
- Если DATABASE_URL не задан — сервер будет работать как раньше, только без сохранения истории.
