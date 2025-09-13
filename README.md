# PICK–CAM (Flask)

Minimal instructions to run locally and deploy on Render with S3 + CloudFront + Postgres.

## Local development

1. Python 3.10+
2. Install deps:
```
pip install -r requirements.txt
```
3. Copia `.env.example` a `.env` y define al menos `SECRET_KEY`.
4. Ejecuta:
```
python app_full_v2.py
```
App: http://localhost:5000

## Variables de entorno (principales)
- `SECRET_KEY`
- `SMTP_SERVER`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `FROM_EMAIL`, `FROM_NAME`
- `DATABASE_URL` (Postgres en prod; SQLite fallback en dev). Acepta `postgres://`.
- `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET_ORIGINALS`, `CDN_DOMAIN`
- `ALLOW_LOCAL_UPLOAD` (true/false)

## Almacenamiento de archivos
- Dev: `static/uploads/` (local).
- Prod: S3 + CloudFront.
  - Flujo frontend: `POST /api/photos/presign` → PUT a S3 → `POST /api/photos/register`.
  - Sirve imágenes por `https://CDN_DOMAIN/<s3_key>` si defines `CDN_DOMAIN`.

## Deploy en Render
1. Crea un Web Service desde este repo.
2. Start command:
```
python app_full_v2.py
```
3. Añade env vars (arriba). En prod pon `ALLOW_LOCAL_UPLOAD=false`.
4. Añade Postgres gestionado y define `DATABASE_URL`.
5. Añade credenciales AWS y `S3_BUCKET_ORIGINALS`.

## Reportes
- Quick Report (PDFMake) comprime imágenes cliente (1500px ~78%).
- Envío por correo: campo Emails (coma separada) y endpoint `/api/reports/email`.
- Notas de inspección: UI en `project.html`, guardadas en `notes.txt`, anexadas al PDF.

## Costos (referencia)
- Render Web: 7–25 USD; Postgres: 7–15 USD.
- S3: ~23 USD/TB; CloudFront: ~0.085 USD/GB (egreso).