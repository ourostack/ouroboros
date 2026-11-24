// Browser features every arm's page gets before its code runs, the ones jsdom leaves out and a browser has (the kits'
// own tests run in real browsers). Each does nothing observable: no layout, no motion, no media query matches, so no
// kit gains from them over another. Runs in the page's realm.
(function () {
  var noop = function () {}
  if (typeof window.CSS === "undefined") {
    window.CSS = {
      supports: function () { return false },
      escape: function (value) { return String(value).replace(/[^a-zA-Z0-9_ -￿-]/g, function (c) { return "\\" + c }) },
    }
  }
  function Observer() {}
  Observer.prototype.observe = noop
  Observer.prototype.unobserve = noop
  Observer.prototype.disconnect = noop
  Observer.prototype.takeRecords = function () { return [] }
  if (typeof window.ResizeObserver === "undefined") window.ResizeObserver = Observer
  if (typeof window.IntersectionObserver === "undefined") window.IntersectionObserver = Observer
  if (typeof window.matchMedia !== "function") {
    window.matchMedia = function (media) {
      return { matches: false, media: String(media), onchange: null, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop, dispatchEvent: function () { return false } }
    }
  }
  var element = window.Element.prototype
  if (typeof element.scrollIntoView !== "function") element.scrollIntoView = noop
  if (typeof element.scrollTo !== "function") element.scrollTo = noop
  if (typeof element.getAnimations !== "function") element.getAnimations = function () { return [] }
  if (typeof element.hasPointerCapture !== "function") element.hasPointerCapture = function () { return false }
  if (typeof element.setPointerCapture !== "function") element.setPointerCapture = noop
  if (typeof element.releasePointerCapture !== "function") element.releasePointerCapture = noop
  if (typeof window.document.getAnimations !== "function") window.document.getAnimations = function () { return [] }
  var dialog = window.HTMLDialogElement && window.HTMLDialogElement.prototype
  if (dialog && typeof dialog.showModal !== "function") {
    dialog.show = function () { this.setAttribute("open", "") }
    dialog.showModal = function () { this.setAttribute("open", "") }
    dialog.close = function (value) {
      if (!this.hasAttribute("open")) return
      if (value !== undefined) this.returnValue = String(value)
      this.removeAttribute("open")
      this.dispatchEvent(new window.Event("close"))
    }
  }
})()
