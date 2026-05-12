"use client"

/**
 * Drawer — bottom-sheet wrapper над Base UI Drawer (drop-in замена Vaul).
 *
 * Migration A.bis.0 (2026-05-12): Vaul 1.1.2 UNMAINTAINED (17mo stale, README
 * explicit) → @base-ui/react 1.4.1 GA (2026-04-20, MIT). Base UI Drawer
 * preserves drag-to-dismiss UX (swipeDirection + snapPoints + CSS vars
 * --drawer-swipe-movement-y) — critical для guest mobile widget UX.
 *
 * API surface — same as old Vaul wrapper (drop-in для existing consumers):
 *   Drawer, DrawerTrigger, DrawerPortal, DrawerOverlay, DrawerContent,
 *   DrawerHeader, DrawerFooter, DrawerTitle, DrawerDescription, DrawerClose
 *
 * Internal mapping (Base UI structure differs from Vaul):
 *   Drawer.Portal → Drawer.Viewport → Drawer.Popup → Drawer.Content
 *   Drawer.Backdrop (was Drawer.Overlay в Vaul)
 *   No built-in Header/Footer (compose freely)
 *
 * Default direction: `down` (bottom drawer, canonical mobile peek pattern).
 * Consumers can override via `<Drawer swipeDirection="up|left|right">`.
 *
 * Data attributes (Base UI):
 *   - `data-open` / `data-closed` — state
 *   - `data-swipe-direction` — current swipe direction (matches root prop)
 *   - `data-swiping` — active gesture
 *   - `--drawer-swipe-movement-y` CSS var — drag offset
 */

import * as React from "react"
import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer"

import { cn } from "@/lib/utils"

function Drawer({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Root>) {
  return <DrawerPrimitive.Root data-slot="drawer" {...props} />
}

function DrawerTrigger({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Trigger>) {
  return <DrawerPrimitive.Trigger data-slot="drawer-trigger" {...props} />
}

function DrawerPortal({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Portal>) {
  return <DrawerPrimitive.Portal data-slot="drawer-portal" {...props} />
}

function DrawerClose({
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Close>) {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />
}

/**
 * Overlay = Backdrop в Base UI. Name kept «DrawerOverlay» для consumer
 * API compatibility.
 */
function DrawerOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Backdrop>) {
  return (
    <DrawerPrimitive.Backdrop
      data-slot="drawer-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/10 supports-backdrop-filter:backdrop-blur-xs data-[open]:animate-in data-[open]:fade-in-0 data-[closed]:animate-out data-[closed]:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

/**
 * DrawerContent wraps Base UI's `Portal → Viewport → Popup` chain — consumers
 * только pass children + className. Drag-handle rendered внутри Popup (canonical
 * shadcn pattern preserved).
 *
 * Direction styling matches `data-swipe-direction` set by Base UI на Popup
 * (mirrors Root's swipeDirection prop). Default «down» = bottom drawer.
 */
function DrawerContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Popup>) {
  return (
    <DrawerPortal data-slot="drawer-portal">
      <DrawerOverlay />
      <DrawerPrimitive.Viewport>
        <DrawerPrimitive.Popup
          data-slot="drawer-content"
          className={cn(
            "group/drawer-content fixed z-50 flex h-auto flex-col bg-popover text-sm text-popover-foreground",
            // Direction-specific positioning + animation. Base UI propagates
            // root's swipeDirection как data-swipe-direction на Popup.
            "data-[swipe-direction=down]:inset-x-0 data-[swipe-direction=down]:bottom-0 data-[swipe-direction=down]:mt-24 data-[swipe-direction=down]:max-h-[80vh] data-[swipe-direction=down]:rounded-t-xl data-[swipe-direction=down]:border-t",
            "data-[swipe-direction=up]:inset-x-0 data-[swipe-direction=up]:top-0 data-[swipe-direction=up]:mb-24 data-[swipe-direction=up]:max-h-[80vh] data-[swipe-direction=up]:rounded-b-xl data-[swipe-direction=up]:border-b",
            "data-[swipe-direction=left]:inset-y-0 data-[swipe-direction=left]:left-0 data-[swipe-direction=left]:w-3/4 data-[swipe-direction=left]:rounded-r-xl data-[swipe-direction=left]:border-r data-[swipe-direction=left]:sm:max-w-sm",
            "data-[swipe-direction=right]:inset-y-0 data-[swipe-direction=right]:right-0 data-[swipe-direction=right]:w-3/4 data-[swipe-direction=right]:rounded-l-xl data-[swipe-direction=right]:border-l data-[swipe-direction=right]:sm:max-w-sm",
            // Animation states (Base UI same data-open/data-closed convention).
            "data-[open]:animate-in data-[open]:fade-in-0 data-[closed]:animate-out data-[closed]:fade-out-0",
            "data-[swipe-direction=down]:data-[open]:slide-in-from-bottom-10 data-[swipe-direction=down]:data-[closed]:slide-out-to-bottom-10",
            "data-[swipe-direction=up]:data-[open]:slide-in-from-top-10 data-[swipe-direction=up]:data-[closed]:slide-out-to-top-10",
            "data-[swipe-direction=left]:data-[open]:slide-in-from-left-10 data-[swipe-direction=left]:data-[closed]:slide-out-to-left-10",
            "data-[swipe-direction=right]:data-[open]:slide-in-from-right-10 data-[swipe-direction=right]:data-[closed]:slide-out-to-right-10",
            className
          )}
          {...props}
        >
          {/*
           * Drag-handle (gray pill at top для bottom drawer). Visible только
           * для bottom direction — это canonical pattern (top/left/right
           * drawers не имеют handle). Hidden by default; bottom variant
           * unhides через group-data attribute.
           */}
          <div className="mx-auto mt-4 hidden h-1 w-[100px] shrink-0 rounded-full bg-muted group-data-[swipe-direction=down]/drawer-content:block" />
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPortal>
  )
}

/**
 * DrawerHeader — custom `<div>` wrapper (Base UI has no Header primitive,
 * unlike Radix Sheet). Composition pattern: title + description live inside.
 */
function DrawerHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-header"
      className={cn(
        "flex flex-col gap-0.5 p-4 group-data-[swipe-direction=down]/drawer-content:text-center group-data-[swipe-direction=up]/drawer-content:text-center md:gap-0.5 md:text-left",
        className
      )}
      {...props}
    />
  )
}

function DrawerFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="drawer-footer"
      className={cn("mt-auto flex flex-col gap-2 p-4", className)}
      {...props}
    />
  )
}

function DrawerTitle({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Title>) {
  return (
    <DrawerPrimitive.Title
      data-slot="drawer-title"
      className={cn(
        "font-heading text-base font-medium text-foreground",
        className
      )}
      {...props}
    />
  )
}

function DrawerDescription({
  className,
  ...props
}: React.ComponentProps<typeof DrawerPrimitive.Description>) {
  return (
    <DrawerPrimitive.Description
      data-slot="drawer-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  )
}

export {
  Drawer,
  DrawerPortal,
  DrawerOverlay,
  DrawerTrigger,
  DrawerClose,
  DrawerContent,
  DrawerHeader,
  DrawerFooter,
  DrawerTitle,
  DrawerDescription,
}
