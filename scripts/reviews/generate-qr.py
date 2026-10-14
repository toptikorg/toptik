"""Generate local QR images and require a successful independent decode before release."""
import json, pathlib, sys
import qrcode
import qrcode.image.svg
import zxingcpp
from PIL import Image
from urllib.parse import urlparse

root = pathlib.Path(__file__).resolve().parents[2]
branches = json.loads((root / 'src/components/reviews/branches.json').read_text(encoding='utf-8'))
assert len(branches) == 3 and {b['id'] for b in branches} == {'gan', 'ramat', 'weiz'}
for b in branches:
    u = urlparse(b['reviewUrl'])
    assert b['verified'] and u.scheme == 'https' and u.netloc == 'g.page' and u.path.endswith('/review'), 'Official review URL still missing or unverified'
    assert b['qrPath'] == '/reviews/' + b['id'] + '.svg'
out = root / 'public/reviews'
out.mkdir(parents=True, exist_ok=True)
evidence = []
for b in branches:
    code = qrcode.QRCode(error_correction=qrcode.constants.ERROR_CORRECT_M, box_size=10, border=4)
    code.add_data(b['reviewUrl']); code.make(fit=True)
    png = code.make_image(fill_color='black', back_color='white').convert('RGB')
    decoded = zxingcpp.read_barcodes(png)
    assert len(decoded) == 1 and decoded[0].text == b['reviewUrl'], 'QR decode mismatch'
    code.make_image(image_factory=qrcode.image.svg.SvgPathImage).save(out / (b['id'] + '.svg'))
    png.save(out / (b['id'] + '.png'))
    evidence.append({'id':b['id'],'url':b['reviewUrl'],'decoded':decoded[0].text})
(out / 'verification.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2),encoding='utf-8')
print('3 official links encoded and decoded successfully')
