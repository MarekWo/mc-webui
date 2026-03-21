# How to Manage Your Repeater

This guide explains how to manage a MeshCore repeater device directly from the mc-webui interface using Direct Messages.

---

## 1. Add Your Repeater to Contacts

- Wait for your repeater's first `advert`
- Click on the Contacts icon

    <img src="../images/RPT-Mgmt-01-new-rpt-notification.png" alt="New repeater notification" width="200px">

- Go to `Pending contacts` panel

    <img src="../images/RPT-Mgmt-02-new-rpt-pending.png" alt="Pending contacts" width="200px">

- Search for your repeater on the list and approve it

    <img src="../images/RPT-Mgmt-03-new-rpt-approve.png" alt="Approve repeater" width="200px">

- Reset your search filter (it is recommended to leave COM selected only) and return to the main chat view

    <img src="../images/RPT-Mgmt-04-back-to-home.png" alt="Return to home" width="200px">

---

## 2. Login to Your Repeater and Initialize Conversation

- Open the `meshcli Console`

    <img src="../images/RPT-Mgmt-05-open-console.png" alt="Console" width="200px">

- Enter the `login <REPEATER_NAME> <password>` command
- Type the `msg <REPEATER_NAME> "Hello"` command (you can use any message text)

    <img src="../images/RPT-Mgmt-06-login-and-msg.png" alt="Login" width="200px">

- Return to the main chat view

---

## 3. Send Commands to Your Repeater

- From the main chat view, click on the DM icon

    <img src="../images/RPT-Mgmt-07-dm-notification.png" alt="DM notification" width="200px">

- Find your repeater's name on the list

    <img src="../images/RPT-Mgmt-08-dm-open.png" alt="Open DM chat" width="200px">

- Start sending commands to your repeater as if it were a regular DM conversation

    <img src="../images/RPT-Mgmt-09-rpt-commands.png" alt="Repeater commands" width="200px">

For full commands reference, see [Repeater & Room Server CLI Reference](https://github.com/meshcore-dev/MeshCore/wiki/Repeater-&-Room-Server-CLI-Reference).

**Note:** Not all commands may work at the moment.
