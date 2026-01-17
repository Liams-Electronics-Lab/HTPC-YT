
<div align="center">
<img width="479" height="479" alt="icon" src="https://github.com/user-attachments/assets/a9f26fe9-a5dd-4f9e-8253-639dab5813ca" />
</div>


# HTPC-YT

A fullscreen Electron application that loads the Youtube TV interface, designed for keyboard or remote control navigation.

I made this app to fufill a need of mine. I recently purchased a commercial display to use as a TV, however being the type of device it is, it lacks any "apps".

This program is a Windows electron based execuatble that loads the Youtube "TV" interface, the same way that a lot of cheap smart TVs (like my previous linux based Hisense unit) run Youtube.

basically its a custom web browser..


Anyway, I didnt find a project I liked that worked with my specific remote control well, so I made this.


...
![thumb](https://github.com/user-attachments/assets/d696a336-2851-4a72-86e7-782a24129cad)
## Features
- Frameless Fullscreen mode
- Hidden cursor
- Custom User Agent Support, the program includes a tested useragent that has 4k 60FPS playback and audio dubbing support.
- Loads https://youtube.com/tv
- Portable
- Easy reset
- Exit prompt screen
- Customizable key debounce
- Simple controls (Directional, enter, escape)

## Installation

Download latest execuatble from releases or build it yourself 

1. Install dependencies:
   ```bash
   npm install
   ```

2. Run the application:
   ```bash
   npm start
   ```

## Shortcuts

- **Exit Application**: Press `Escape` or `Back` on the Home screen to bring up the Exit Menu.
- **Settings**: Open the Exit Menu and select "App Settings" to change resolution or fullscreen mode.
- **Navigation**: Use Arrow keys to navigate, Enter to select.

## Build

To create a standalone executable:

```bash
npm run dist
```

The output will be available in the `dist/htpc-yt-win32-x64` folder.
Run `htpc-yt.exe` to start the application.

## Settings

User settings are stored in Settings.ini (auto generated if missing)

```code
width= (screen resolution)
height= ("")
fullscreen= (True or False)
userAgent= (one is provided but if you ever need to chnage it you can here)
inputDebounce= (delay in ms added to key inputs)
showUrl= (show the current page in bottom right of screen)
```
