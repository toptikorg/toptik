"""Prepare an approved theme patch locally. This program never uploads/deploys."""
import argparse, hashlib, json, pathlib, shutil, subprocess

parser=argparse.ArgumentParser()
parser.add_argument('--theme-dir',required=True)
args=parser.parse_args()
package=pathlib.Path(__file__).resolve().parent
target=pathlib.Path(args.theme_dir).resolve()
expected=json.loads((package/'baseline.json').read_text(encoding='utf-8'))
for name,digest in expected.items():
    data=(target/name).read_bytes().replace(b'\r\n',b'\n')
    if hashlib.sha256(data).hexdigest()!=digest:
        raise SystemExit('STOP: live theme changed since review: '+name)
for source in (package/'theme').rglob('*.liquid'):
    dest=target/source.relative_to(package/'theme')
    if dest.exists():
        raise SystemExit('STOP: new snippet already exists: '+str(dest))
patch=package/'theme.patch'
subprocess.run(['git','apply','--check',str(patch)],cwd=target,check=True)
subprocess.run(['git','apply',str(patch)],cwd=target,check=True)
for source in (package/'theme').rglob('*.liquid'):
    dest=target/source.relative_to(package/'theme')
    dest.parent.mkdir(parents=True,exist_ok=True)
    shutil.copyfile(source,dest)
print('Prepared locally only. Upload and publication require Tal approval.')
