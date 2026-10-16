# Landing car

A flying car dropped at a random height and attitude, landed by **Laya** (Ollaya's System One API). Laya reads plain-language flight reports, and its answers set which of the 8 thrusters fire and how hard.

## Run

1. Create `.env` next to `server.py`:

   ```bash
   OLLAYA_URL="http://<ollaya-host>:11435"
   OLLAYA_API_KEY="<your key>"
   OLLAYA_MODEL="laya:latest"
   ```

2. Start the server (Python 3.9+, no installs):

   ```bash
   python3 server.py
   ```

3. Open **http://localhost:8000/car**. Use `http://localhost:8000/car?square` for a square frame to record.

**More pilots:** every `<NAME>_URL` + `<NAME>_API_KEY` (+ `<NAME>_MODEL`) in `.env` is a pilot, e.g. `JEV_URL="https://api.typesafe.ai"`, `JEV_API_KEY`, `JEV_MODEL="jev-latest"`. All of them fly the identical drop at once, overlapping on one pad; pick some with `/car?pilots=ollaya,jev`.

The page loads three.js from a CDN, so the browser needs internet access.

## Test (optional)

```bash
npm install
npm run flight-test             # 40 headless drops replaying recorded Laya answers
MODE=laya npm run flight-test   # real Laya, real time
MODE=laya PILOT=jev npm run flight-test   # any pilot from .env
```
