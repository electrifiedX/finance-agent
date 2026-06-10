"""
jobs/gmail_auth.py — ONE-TIME Gmail authorization.

Run this once on the Mini. It opens a browser, you approve READ-ONLY access to your Gmail,
and it saves a reusable token to secrets/gmail_token.json. After that, the polling job reads
your inbox using that token without prompting again.

Scope is gmail.readonly ONLY — this can never send, delete, or modify your email.

Usage:
  cd ~/Developer/finance-agent
  pip install google-auth google-auth-oauthlib google-api-python-client --break-system-packages
  python -m jobs.gmail_auth
"""

import os
from google_auth_oauthlib.flow import InstalledAppFlow
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT_FILE = os.path.join(HERE, "secrets", "gmail_client.json")
TOKEN_FILE = os.path.join(HERE, "secrets", "gmail_token.json")


def main():
    if not os.path.exists(CLIENT_FILE):
        raise SystemExit(f"Missing {CLIENT_FILE} — download the OAuth client JSON and place it there.")

    flow = InstalledAppFlow.from_client_secrets_file(CLIENT_FILE, SCOPES)
    # Opens a browser for you to approve. Click through the "unverified app" warning
    # (Advanced -> Go to ... (unsafe)) — it's your own app reading your own mail, read-only.
    creds = flow.run_local_server(port=0)

    with open(TOKEN_FILE, "w") as f:
        f.write(creds.to_json())
    os.chmod(TOKEN_FILE, 0o600)
    print(f"\nToken saved to {TOKEN_FILE}")

    # Sanity check: read the inbox profile + a couple of recent alert senders.
    service = build("gmail", "v1", credentials=creds)
    profile = service.users().getProfile(userId="me").execute()
    print(f"Authorized for: {profile['emailAddress']}  ({profile.get('messagesTotal','?')} messages total)")
    print("Auth OK. You can now run the ingestion job.")


if __name__ == "__main__":
    main()
