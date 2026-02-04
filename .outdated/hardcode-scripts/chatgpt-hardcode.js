(async () => {
  const chatId = window.location.pathname.split('/c/')[1];
  const url = `https://chatgpt.com/backend-api/conversation/${chatId}`;
  
  const response = await fetch(url, {
    method: 'GET',
    credentials: 'include',
    headers: {
      'accept': 'application/json',
      'authorization': 'Bearer eyJhbGciOiJSUzI1NiIsImtpZCI6IjE5MzQ0ZTY1LWJiYzktNDRkMS1hOWQwLWY5NTdiMDc5YmQwZSIsInR5cCI6IkpXVCJ9.eyJhdWQiOlsiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS92MSJdLCJjbGllbnRfaWQiOiJhcHBfWDh6WTZ2VzJwUTl0UjNkRTduSzFqTDVnSCIsImV4cCI6MTc3MDc0ODYwMiwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS9hdXRoIjp7ImNoYXRncHRfY29tcHV0ZV9yZXNpZGVuY3kiOiJub19jb25zdHJhaW50IiwiY2hhdGdwdF9kYXRhX3Jlc2lkZW5jeSI6Im5vX2NvbnN0cmFpbnQiLCJ1c2VyX2lkIjoidXNlci1NZVF6ZmJoSHFvWEdIcmg5blJLUnZWOG8ifSwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS9wcm9maWxlIjp7ImVtYWlsIjoiYWRpdHlhMjAxN3Jrc0BnbWFpbC5jb20iLCJlbWFpbF92ZXJpZmllZCI6dHJ1ZX0sImlhdCI6MTc2OTg4NDYwMiwiaXNzIjoiaHR0cHM6Ly9hdXRoLm9wZW5haS5jb20iLCJqdGkiOiJiNDk3NmNkNC1lNGNjLTQ1NTEtODM4OS0wYjdjNDUzYzUxNWYiLCJuYmYiOjE3Njk4ODQ2MDIsInB3ZF9hdXRoX3RpbWUiOjE3NjgxMzEwNzIyNzcsInNjcCI6WyJvcGVuaWQiLCJlbWFpbCIsInByb2ZpbGUiLCJvZmZsaW5lX2FjY2VzcyIsIm1vZGVsLnJlcXVlc3QiLCJtb2RlbC5yZWFkIiwib3JnYW5pemF0aW9uLnJlYWQiLCJvcmdhbml6YXRpb24ud3JpdGUiXSwic2Vzc2lvbl9pZCI6ImF1dGhzZXNzX0hLQXRlak5iQ1Q5UTBUY1ZtdWtHeTRvSSIsInN1YiI6Imdvb2dsZS1vYXV0aDJ8MTAxNjY4MzIxMTYzMDI3Njk2OTc3In0.xlNioU4H3mKojSoN78Ws94kOtCw7DzE5jtCTQS93KACrMheu7SvLQmINSpa4VkiuCv8zt034ZBRth2Gd1e46TY1DLl9gMYJ207e_OFD03LfZK3apeqy5oX1gb9yPd7m7lnTgz_tTeEXRfoWOVIDHM_mDGZRnSCrXHa7kPN9Rv-WXyitb1ATd8GlJgqOT6VHLFi5hcOjc7apeBO-yrMiwY-2Uc423SCsAPMTBiVmsVYvGixYA1M4rdCwrjEj5LN4WHsSEnSpaxqp6_mvCPErjcbSHGB4-tHpCFWd7Xuw96IV_oQyC_cgxsdiS04ZOAv9n_nRp5bJxZCOKnbBXz5rcep5XsAjSCXRR_cpkAdkhJ3FuJr7rjUdBUBfu1yR2eCQYIhdnoa-JHGMFj80ok1xQxsEaQ9piJ7vjCXp40AvTPqtr3dJUXsZbyU74SyflYHmjACFnN_m9C43Gk_uPnwzCjuD0WAYN1q7ocNwD9eN97ZDN7c_3OSCrhNqzilLhVYnWS01OEJTH32aK0vqvhihWDHdx2TsYs5xKajEZkzikL6mr88ZzBZiHkjsqUrco28OIZfi1oPHmhfKtW79l53O9SBrNE48Ic4YE0In8kfCG7uu89wO4Rm26C3IMZM721yg_z7kkc_JOfPdK_oilw7CGkbry0Cg3COSLGQjXxzfot-4', 
    }
  });
  
  if (!response.ok) {
    console.error('Failed:', response.status);
    const error = await response.text();
    console.error('Error:', error);
    return;
  }
  
  const data = await response.json();
  
  const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
  const downloadUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = downloadUrl;
  a.download = `chatgpt_${chatId}.json`;
  a.click();
  
  console.log('✅ Downloaded:', chatId);
})();