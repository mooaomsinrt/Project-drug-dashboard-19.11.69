from argparse import ArgumentParser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import IPv4Address
from pathlib import Path
from urllib.parse import urlsplit
import webbrowser


class DashboardHandler(SimpleHTTPRequestHandler):
    allowed_paths = {
        "/", "/index.html", "/styles.css", "/app.js", "/dashboard-qr.png",
        "/assets/pharmacy-still-life.jpg", "/data/drugs_update.json",
        "/data/stock.json", "/data/dispense-log.json",
    }

    def send_head(self):
        if urlsplit(self.path).path not in self.allowed_paths:
            self.send_error(404)
            return None
        return super().send_head()


if __name__ == "__main__":
    parser = ArgumentParser()
    parser.add_argument("--host", type=IPv4Address, default=IPv4Address("127.0.0.1"))
    parser.add_argument("--no-open", action="store_true")
    args = parser.parse_args()
    if args.host.is_unspecified or not args.host.is_private:
        parser.error("Choose a specific private IPv4 address for this dashboard.")
    directory = Path(__file__).resolve().parent
    handler = partial(DashboardHandler, directory=str(directory))
    with ThreadingHTTPServer((str(args.host), 8770), handler) as server:
        url = f"http://{args.host}:{server.server_port}/"
        print(url, flush=True)
        if not args.no_open:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
