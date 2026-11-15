#!/usr/bin/env python3
import subprocess
import shutil
import sys
import webbrowser

def open_chrome(url: str):
    """Open the given URL in Chrome if possible, otherwise fall back to the default browser.
    Attempts to launch Chrome, then xdg-open/open, then Python's webbrowser.
    If all fail, prints the URL to the console.
    """
    # Try common Chrome executable names
    for cmd in ("google-chrome", "google-chrome-stable", "chrome", "chromium", "chromium-browser"):
        if shutil.which(cmd):
            try:
                subprocess.run([cmd, url], check=False)
                return
            except Exception as e:
                print(f"Failed to launch {cmd}: {e}", file=sys.stderr)
    # If Chrome not found, print the URL for manual opening
    print(f"Please open this URL manually: {url}", file=sys.stderr)

if __name__ == "__main__":
    open_chrome("https://google.com")
