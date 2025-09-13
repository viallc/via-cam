import os
import io
import json
import time
import math
import argparse
import requests
import boto3
from PIL import Image, ExifTags
import piexif

AWS_REGION = os.getenv('AWS_REGION', 'us-east-1')
DERIV_BUCKET = os.getenv('DERIVATIVES_BUCKET')
CDN_DERIV = os.getenv('CDN_DOMAIN_DERIVATIVES', '')
APP_BASE_URL = os.getenv('APP_BASE_URL')
WEBHOOK_SECRET = os.getenv('WEBHOOK_SECRET', 'CHANGE_ME')
MAX_WEB = int(os.getenv('MAX_WEB', '1600'))
MAX_THUMB = int(os.getenv('MAX_THUMB', '400'))

s3 = boto3.client('s3', region_name=AWS_REGION)

def _ratio_resize(img: Image.Image, max_side: int) -> Image.Image:
    w, h = img.size
    if max(w, h) <= max_side:
        return img.copy()
    if w >= h:
        new_w = max_side
        new_h = int(h * (max_side / w))
    else:
        new_h = max_side
        new_w = int(w * (max_side / h))
    return img.resize((new_w, new_h), Image.LANCZOS)

def _exif_to_dict(exif_bytes: bytes):
    try:
        exif_dict = piexif.load(exif_bytes)
    except Exception:
        return {}
    return exif_dict

def _get_datetime(exif_dict) -> str | None:
    # common tags: DateTimeOriginal, CreateDate, DateTime
    for ifd in ("Exif", "0th"):
        for tag_name in ("DateTimeOriginal", "CreateDate", "DateTime"):
            tag_id = piexif.ExifIFD.DateTimeOriginal if tag_name=="DateTimeOriginal" else (
                piexif.ExifIFD.DateTimeDigitized if tag_name=="CreateDate" else piexif.ImageIFD.DateTime
            )
            try:
                val = exif_dict[ifd].get(tag_id)
                if val:
                    if isinstance(val, bytes): val = val.decode('utf-8', 'ignore')
                    # format "YYYY:MM:DD HH:MM:SS"
                    return val.replace(':', '-', 2).replace(' ', 'T') + 'Z'
            except Exception:
                pass
    return None

def _gps_to_decimal(exif_dict):
    try:
        gps_ifd = exif_dict.get('GPS', {})
        if not gps_ifd: return None, None

        def _dms_to_deg(values):
            # values: [(num, den), (num, den), (num, den)]
            d = values[0][0] / values[0][1]
            m = values[1][0] / values[1][1]
            s = values[2][0] / values[2][1]
            return d + (m / 60.0) + (s / 3600.0)

        lat_ref = gps_ifd.get(piexif.GPSIFD.GPSLatitudeRef, b'N').decode()
        lng_ref = gps_ifd.get(piexif.GPSIFD.GPSLongitudeRef, b'E').decode()
        lat = _dms_to_deg(gps_ifd[piexif.GPSIFD.GPSLatitude])
        lng = _dms_to_deg(gps_ifd[piexif.GPSIFD.GPSLongitude])
        if lat_ref == 'S': lat = -lat
        if lng_ref == 'W': lng = -lng
        return lat, lng
    except Exception:
        return None, None

def process_image_bytes(img_bytes: bytes):
    with Image.open(io.BytesIO(img_bytes)) as im:
        # orient
        try:
            im = ImageOps.exif_transpose(im)  # auto-rotate if needed
        except Exception:
            pass
        exif_bytes = im.info.get('exif', b'')
        exif_dict = _exif_to_dict(exif_bytes) if exif_bytes else {}
        taken_at = _get_datetime(exif_dict)
        lat, lng = _gps_to_decimal(exif_dict)
        # make web + thumb
        web = _ratio_resize(im, MAX_WEB).convert('RGB')
        buf_web = io.BytesIO()
        web.save(buf_web, format='WEBP', quality=88, method=6)
        buf_web.seek(0)

        thumb = _ratio_resize(im, MAX_THUMB).convert('RGB')
        buf_thumb = io.BytesIO()
        thumb.save(buf_thumb, format='WEBP', quality=82, method=6)
        buf_thumb.seek(0)

        return {
            "web_bytes": buf_web.getvalue(),
            "thumb_bytes": buf_thumb.getvalue(),
            "taken_at": taken_at,
            "gps_lat": lat,
            "gps_lng": lng,
            "web_size": web.size,
            "thumb_size": thumb.size,
        }

def upload_derivatives(original_key: str, web_bytes: bytes, thumb_bytes: bytes):
    # build derivative keys
    base = original_key.rsplit('.', 1)[0]
    key_web = f"{base}_web.webp"
    key_thumb = f"{base}_thumb.webp"
    s3.put_object(Bucket=DERIV_BUCKET, Key=key_web, Body=web_bytes, ContentType='image/webp', ACL='public-read')
    s3.put_object(Bucket=DERIV_BUCKET, Key=key_thumb, Body=thumb_bytes, ContentType='image/webp', ACL='public-read')
    return key_web, key_thumb

def callback_update(app_base: str, payload: dict):
    url = app_base.rstrip('/') + '/api/photos/update_meta'
    headers = {'Content-Type': 'application/json', 'X-Webhook-Secret': WEBHOOK_SECRET}
    r = requests.post(url, headers=headers, data=json.dumps(payload), timeout=10)
    if r.status_code >= 400:
        # retry once
        time.sleep(1.5)
        r = requests.post(url, headers=headers, data=json.dumps(payload), timeout=10)
    return r.status_code, r.text

def lambda_handler(event, context):
    # S3 event
    rec = event['Records'][0]
    bucket = rec['s3']['bucket']['name']
    key = rec['s3']['object']['key']

    # Download original
    obj = s3.get_object(Bucket=bucket, Key=key)
    body = obj['Body'].read()

    # Process
    out = process_image_bytes(body)
    key_web, key_thumb = upload_derivatives(key, out['web_bytes'], out['thumb_bytes'])

    # Build payload
    payload = {
        "s3_key_original": key,
        "s3_key_web": key_web,
        "s3_key_thumb": key_thumb,
        "taken_at": out['taken_at'],
        "gps_lat": out['gps_lat'],
        "gps_lng": out['gps_lng'],
        "width": out['web_size'][0],
        "height": out['web_size'][1],
    }
    status, text = callback_update(APP_BASE_URL, payload)
    return {"statusCode": status, "body": text}

if __name__ == "__main__":
    # local test mode
    parser = argparse.ArgumentParser()
    parser.add_argument('--local', help='Path to local image')
    parser.add_argument('--outdir', help='Output dir', default='./out')
    args = parser.parse_args()
    if args.local:
        os.makedirs(args.outdir, exist_ok=True)
        with open(args.local, 'rb') as f:
            b = f.read()
        result = process_image_bytes(b)
        with open(os.path.join(args.outdir, 'web.webp'), 'wb') as fw:
            fw.write(result['web_bytes'])
        with open(os.path.join(args.outdir, 'thumb.webp'), 'wb') as ft:
            ft.write(result['thumb_bytes'])
        print(json.dumps({
            "taken_at": result['taken_at'],
            "gps_lat": result['gps_lat'],
            "gps_lng": result['gps_lng'],
            "web_size": result['web_size'],
            "thumb_size": result['thumb_size']
        }, indent=2))
        print("Wrote out/web.webp and out/thumb.webp")