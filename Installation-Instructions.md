# Running the Bridge server (for the host)

## 1. Unzip

Unzip the folder you received anywhere on your PC (e.g. your Desktop).

## 2. Start the server

Double-click **start-bridge-server.bat** inside that folder.

A black command-window will open. Leave it open the whole time you're
playing — closing it stops the server for everyone.

## 3. Allow it through the firewall

If Windows asks "Windows Defender Firewall has blocked some features of
this app", click **Allow access** (choose Private networks at minimum).
This is needed so the other players on your WiFi/network can connect.

## 4. Find your links

After a few seconds, you'll see two lines like this:

```
Bridge multiplayer server local:   http://127.0.0.1:5173/
Bridge multiplayer server network: http://192.168.1.73:5173/
```

- **local** link → open this yourself, on the host PC.
- **network** link → send this to the other players and any spectators
  on the same WiFi/network. They just paste it into any browser
  (Chrome, Edge, Safari, etc.) — nothing to install.

## 5. Play

- 2 players + 2 robots, or 4 human players — everyone opens the network
  link in their own browser.
- Extra browsers on the same network can join as spectators.

## 6. Stopping the server

Close the black command window, or press Ctrl+C inside it.

---

**Note:** Everyone connecting must be on the *same* WiFi/local network as
the host PC (this won't work over the internet without extra setup like
port forwarding — ask if you need that instead).
