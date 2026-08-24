"""Rebuild + rerun the kokoro segment progress check against the fresh bundle."""
import time, importlib.util, json
spec = importlib.util.spec_from_file_location('e2e', '/opt/data/yapper/.worktrees/t_1c434172/e2e_test.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)

cdp_holder = {}
m.step_connect_to_cdp(cdp_holder)
m.step_attach_and_navigate(cdp_holder)
target = cdp_holder['target']
cdp = cdp_holder['cdp']
time.sleep(2)

text = ('The quick brown fox jumps over the lazy dog. Yapper speaks every '
        'sentence it reads. Progress should tick as each one completes.')
m._run_kokoro_generation(cdp_holder, text)

seg_timeout = 300
start = time.time()
saw = []
last = ''
while time.time() - start < seg_timeout:
    s = m.v(cdp.eval(m.JOB_HINT_SNAPSHOT_JS, target['id'], timeout=10))
    gen = [c.get('hint') or '' for c in s if c.get('status') == 'generating']
    label = gen[0] if gen else '(none)'
    if label != last:
        print(f'[{int(time.time()-start):3d}s] {label}')
        last = label
        if 'sentence' in label.lower():
            saw.append(label)
    if not gen and any(c.get('status') == 'done' for c in s):
        print('DONE')
        break
    time.sleep(0.5)

print('segment hints seen:', saw)
print('RESULT:', 'PASS' if saw else 'FAIL')
