var canvas = document.getElementById("golCanvas");
var ctx = canvas.getContext("2d");
var LEN = 14;
var deadColor = "#0c1210";
var liveColor = "#1f4f35";
var randomFactor = 0.5;
var myGol;
var golTmp;
var x, y, cells, WIDTH, HEIGHT;

function sizeCanvas() {
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  WIDTH = canvas.width;
  HEIGHT = canvas.height;
  x = Math.floor(WIDTH / LEN) + 2;
  y = Math.floor(HEIGHT / LEN) + 2;
  cells = x * y;
}

sizeCanvas();

function initTmp() {
  for (var xVal = 0; xVal < x; xVal++) {
    golTmp[xVal] = new Array();
    for (var yVal = 0; yVal < y; yVal++) {
      golTmp[xVal][yVal] = 0;
    }
  }
}

function initMatrix() {
  myGol = new Array();
  golTmp = new Array();
  for (var xVal = 0; xVal < x; xVal++) {
    myGol[xVal] = new Array();
    golTmp[xVal] = new Array();
    for (var yVal = 0; yVal < y; yVal++) {
      golTmp[xVal][yVal] = 0;
      myGol[xVal][yVal] = 0;
    }
  }
}

function draw(x, y) {
  ctx.fillRect(LEN * (x - 1), LEN * (y - 1), LEN, LEN);
}

function setCellLive(xVal, yVal) {
  setCell(xVal, yVal, 1, liveColor);
}

function setCellDead(xVal, yVal) {
  setCell(xVal, yVal, 0, deadColor);
}

function setCell(xVal, yVal, live, color) {
  golTmp[xVal][yVal] = live;
  ctx.fillStyle = color;
  draw(xVal, yVal);
}

function initiateCell(xVal, yVal) {
  setCellLive(xVal, yVal);
  myGol[xVal][yVal] = 1;
}

function nextStep() {
  initTmp();
  ctx.fillStyle = deadColor;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  for (var xVal = 0; xVal < x; xVal++) {
    for (var yVal = 0; yVal < y; yVal++) {
      var neighbourSum = 0;

      var xMinus = xVal - 1;
      if (xMinus < 0) xMinus = x - 2;
      var yMinus = yVal - 1;
      if (yMinus < 0) yMinus = y - 2;
      var xPlus = xVal + 1;
      if (xPlus >= x) xPlus = 1;
      var yPlus = yVal + 1;
      if (yPlus >= y) yPlus = 1;

      neighbourSum += myGol[xMinus][yVal];
      neighbourSum += myGol[xMinus][yMinus];
      neighbourSum += myGol[xMinus][yPlus];
      neighbourSum += myGol[xVal][yMinus];
      neighbourSum += myGol[xVal][yPlus];
      neighbourSum += myGol[xPlus][yVal];
      neighbourSum += myGol[xPlus][yMinus];
      neighbourSum += myGol[xPlus][yPlus];

      if (myGol[xVal][yVal] === 1) {
        if (neighbourSum === 2 || neighbourSum === 3) {
          setCellLive(xVal, yVal);
        }
      } else {
        if (neighbourSum === 3) {
          setCellLive(xVal, yVal);
        }
      }

      var randVal = Math.random() * cells;
      if (randVal < randomFactor) {
        setCellLive(xVal, yVal);
      }
    }
  }
  myGol = golTmp.slice();
}

function wrap(val, max) {
  return ((val % max) + max) % max;
}

function onClickPlace(event) {
  delayEditedEvolution();
  var cx = Math.floor(event.clientX / LEN) + 1;
  var cy = Math.floor(event.clientY / LEN) + 1;
  var offsets = [[-1,0],[0,1],[1,-1],[1,0],[1,1]];
  for (var i = 0; i < offsets.length; i++) {
    var gx = wrap(cx + offsets[i][0], x);
    var gy = wrap(cy + offsets[i][1], y);
    initiateCell(gx, gy);
  }
}

function delayEditedEvolution() {
  if (typeof evolve !== 'undefined') {
    clearInterval(evolve);
  }
  if (typeof editDelay !== 'undefined') {
    clearTimeout(editDelay);
  }
  editDelay = setTimeout(startEditedEvolution, edit_delay_t);
}

function startEditedEvolution() {
  evolve = setInterval(nextStep, edited_t);
}

function placeGlider(x_pos, y_pos) {
  initiateCell(x_pos, y_pos);
  initiateCell(x_pos, y_pos + 2);
  initiateCell(x_pos + 1, y_pos + 1);
  initiateCell(x_pos + 1, y_pos + 2);
  initiateCell(x_pos + 2, y_pos + 1);
}

function placeUpGlider(x_pos, y_pos) {
  initiateCell(x_pos, y_pos);
  initiateCell(x_pos, y_pos - 2);
  initiateCell(x_pos - 1, y_pos - 1);
  initiateCell(x_pos - 1, y_pos - 2);
  initiateCell(x_pos - 2, y_pos - 1);
}

function handleResize() {
  sizeCanvas();
  initMatrix();
  placeGlider(Math.floor(x * 0.8), Math.floor(y * 0.2));
  placeGlider(Math.floor(x * 0.8), Math.floor(y * 0.8));
}

var edited_mode = false;
var editDelay;
var edit_delay_t = 1600;
var page_load_t = 5000;
var edited_t = 200;

initMatrix();
placeGlider(Math.floor(x * 0.8), Math.floor(y * 0.2));
placeGlider(Math.floor(x * 0.8), Math.floor(y * 0.8));

var evolve = setInterval(nextStep, page_load_t);
document.addEventListener("click", onClickPlace);
window.addEventListener("resize", handleResize, true);
