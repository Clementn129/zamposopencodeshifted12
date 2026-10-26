export const printHtml = (html: string, title: string = 'Print Document') => {
  const iframe = document.createElement('iframe');
  iframe.style.position = 'absolute';
  iframe.style.width = '0px';
  iframe.style.height = '0px';
  iframe.style.border = 'none';
  iframe.style.visibility = 'hidden';
  iframe.title = title;
  
  document.body.appendChild(iframe);
  
  const doc = iframe.contentWindow?.document;
  if (!doc) {
    console.error('Could not access iframe document');
    document.body.removeChild(iframe);
    return;
  }
  
  doc.open();
  doc.write(`
    <html lang="en">
      <head>
        <title>${title}</title>
        <style>
          @page { size: auto; margin: 10mm; }
          body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
            margin: 0; 
            padding: 0; 
            -webkit-print-color-adjust: exact !important; 
            print-color-adjust: exact !important; 
          }
          * { box-sizing: border-box; }
          ${html.includes('<style>') ? '' : ''}
        </style>
      </head>
      <body>
        ${html}
      </body>
    </html>
  `);
  doc.close();
  
  iframe.contentWindow?.focus();
  
  // Increase timeout slightly to ensure images and styles are fully painted
  setTimeout(() => {
    iframe.contentWindow?.print();
    document.body.removeChild(iframe);
  }, 800);
};
