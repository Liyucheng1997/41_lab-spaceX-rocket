# 本地开发服务器（禁用缓存）：python lab/tools/serve.py [端口]
import http.server, sys, os
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
print(f'http://localhost:{port}/lab/')
http.server.ThreadingHTTPServer(('127.0.0.1', port), H).serve_forever()
