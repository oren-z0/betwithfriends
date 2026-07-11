import QRCode from 'qrcode'

/** Renders a bolt11 invoice as a QR data-URL (lightning: URI for wallet apps). */
export async function invoiceQrDataUrl(bolt11: string): Promise<string> {
  return QRCode.toDataURL(`lightning:${bolt11.toUpperCase()}`, {
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 512,
  })
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
