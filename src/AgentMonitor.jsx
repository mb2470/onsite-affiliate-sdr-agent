<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Onsite Affiliate Banner Prototype</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            background: #faf5f2; /* Warm White for page background, optional */
        }
        .banner {
            width: 1128px;
            height: 191px;
            background-color: #051730; /* Ink Blue */
            position: relative;
            overflow: hidden;
            margin: 20px auto; /* Center on page for preview */
        }
        .center-content {
            position: absolute;
            left: 50%;
            transform: translateX(-50%);
            width: 70%; /* Centered 70% */
            height: 100%;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
        }
        .text {
            font-family: 'Proxima Nova', Arial, sans-serif; /* Proxima Nova or fallback */
            font-weight: bold;
            font-size: 50px; /* Adjusted to fit height */
            color: #49a9de; /* CIQ Blue */
            margin: 0;
            letter-spacing: 1px;
        }
        /* Abstract shapes */
        .shape-circle {
            position: absolute;
            top: 20px;
            left: 150px; /* Positioned within center */
            width: 100px;
            height: 100px;
            border: 4px solid #49a9de;
            border-radius: 50%;
            clip-path: polygon(0 0, 100% 0, 100% 50%, 0 50%); /* Partial circle */
            background: transparent;
        }
        .shape-diamond {
            position: absolute;
            bottom: 30px;
            right: 150px; /* Positioned within center */
            width: 60px;
            height: 60px;
            background: #ed7a24; /* CIQ Orange */
            transform: rotate(45deg);
        }
        .shape-line {
            position: absolute;
            top: 80px;
            left: 300px;
            width: 200px;
            height: 4px;
            background: #49a9de;
            transform: rotate(-15deg);
        }
    </style>
</head>
<body>
    <div class="banner">
        <div class="shape-circle"></div>
        <div class="shape-diamond"></div>
        <div class="shape-line"></div>
        <div class="center-content">
            <h1 class="text">Onsite Affiliate</h1>
        </div>
    </div>
</body>
</html>
