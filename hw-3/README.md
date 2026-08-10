# Raw HTTP server

HTTP-сервер на чистому TCP без використання модулів `http` та `https`.

## Запуск HTTP-сервера

```bash
node src/server.js
```

Сервер запускається за адресою:

```text
http://localhost:3000
```

Перевірка головного маршруту:

```bash
curl -sv http://localhost:3000/
```

Очікувана відповідь містить:

```text
HTTP/1.1 200 OK
Content-Type: text/plain
```

Перевірка парсингу заголовків:

```bash
curl -s http://localhost:3000/headers -H "X-Demo: qwerty"
```

У відповіді мають бути присутні рядки:

```text
host: localhost:3000
x-demo: qwerty
```

Перевірка маршруту, якого не існує:

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/nope
```

Очікуваний результат:

```text
404
```

## Генерація self-signed сертифіката

Команди потрібно виконувати з кореня репозиторію.

Створення папки для сертифікатів:

```bash
mkdir -p certificates
```

Генерація приватного ключа та самопідписаного сертифіката:

```bash
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout certificates/localhost-key.pem \
  -out certificates/localhost-cert.pem \
  -days 365 \
  -subj "/CN=localhost"
```

## Запуск HTTPS-сервера

```bash
node src/https-server.js
```

Сервер запускається за адресою:

```text
https://localhost:3443
```

Перевірка головного маршруту:

```bash
curl -sk https://localhost:3443/
```

Перевірка HTTP-статусу:

```bash
curl -sk -o /dev/null -w "%{http_code}\n" https://localhost:3443/
```

Очікуваний результат:

```text
200
```

## OpenSSL debug session

Перед виконанням команди HTTPS-сервер має бути запущений:

```bash
node src/https-server.js
```

Команда перевірки TLS-з'єднання:

```bash
openssl s_client -connect localhost:3443 -servername localhost
```

Вивід команди:

```text
Connecting to ::1
CONNECTED(00000005)
depth=0 CN=localhost
verify error:num=18:self-signed certificate
verify return:1
depth=0 CN=localhost
verify return:1
---
Certificate chain
 0 s:CN=localhost
   i:CN=localhost
---
Verification error: self-signed certificate
---
New, TLSv1.3, Cipher is TLS_AES_256_GCM_SHA384
Protocol: TLSv1.3
Server public key is 2048 bit
Verify return code: 18 (self-signed certificate)
```

Код помилки `18` означає, що сертифікат є самопідписаним і не належить до
довіреного ланцюжка центрів сертифікації.
