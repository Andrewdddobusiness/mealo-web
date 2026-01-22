-- Enable pro_override for test/dev accounts to bypass AI usage limits
-- This allows unlimited AI usage for testing without affecting production limits

-- Option 1: Enable by email (recommended)
-- UPDATE users 
-- SET pro_override = true 
-- WHERE email = 'your-test-email@example.com';

-- Option 2: Enable by user ID
-- UPDATE users 
-- SET pro_override = true 
-- WHERE id = 'your-user-id-here';

-- To check current status:
-- SELECT id, email, pro_override 
-- FROM users 
-- WHERE email = 'your-test-email@example.com';

-- To disable pro_override:
-- UPDATE users 
-- SET pro_override = false 
-- WHERE email = 'your-test-email@example.com';

-- To reset AI usage for a user (optional, if you want to clear existing counts):
-- DELETE FROM ai_usage WHERE user_id = 'your-user-id-here';
