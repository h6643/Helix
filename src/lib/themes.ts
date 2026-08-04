// Catppuccin / AnuPpuccin theme registry for Helix.
//
// The 25 palettes below are transcribed verbatim from the user's AnuPpuccin
// theme CSS (`--ctp-ext-*` RGB triplets). Each flavor is mapped onto Helix's
// shadcn-style CSS custom properties so the whole UI re-skins when applied.
//
// Applying a flavor injects inline CSS variables onto <html> (documentElement).
// Inline styles win over the `:root` / `.dark` rules in globals.css, so a
// selected flavor fully overrides the built-in cream palette without us having
// to ship a giant CSS block.

type ThemeMode = 'light' | 'dark'

/** Raw Catppuccin palette (RGB triplets as "r, g, b"). */
interface CtpPalette {
  rosewater: string
  flamingo: string
  pink: string
  mauve: string
  red: string
  maroon: string
  peach: string
  yellow: string
  green: string
  teal: string
  sky: string
  sapphire: string
  blue: string
  lavender: string
  text: string
  subtext1: string
  subtext0: string
  overlay2: string
  overlay1: string
  overlay0: string
  surface2: string
  surface1: string
  surface0: string
  base: string
  mantle: string
  crust: string
}

export interface HelixThemeDef {
  id: string
  label: string
  mode: ThemeMode
  ctp: CtpPalette
  /** Paired flavor id for the opposite mode (used by the light/dark toggle). */
  pair?: string
}

const P = (p: CtpPalette): CtpPalette => p

// ── Light flavors ─────────────────────────────────────────────────────────────
const atomLight: CtpPalette = P({
  rosewater: '229, 148, 121', flamingo: '197, 103, 131', pink: '166, 37, 104', mauve: '166, 37, 164',
  red: '231, 85, 69', maroon: '231, 101, 69', peach: '227, 86, 73', yellow: '152, 104, 0',
  green: '78, 162, 76', teal: '0, 188, 182', sky: '0, 132, 188', sapphire: '0, 119, 188',
  blue: '61, 116, 246', lavender: '152, 84, 151', text: '56, 58, 66', subtext1: '77, 80, 91',
  subtext0: '99, 102, 116', overlay2: '123, 124, 138', overlay1: '148, 148, 158', overlay0: '174, 173, 179',
  surface2: '201, 197, 197', surface1: '218, 216, 216', surface0: '237, 237, 237', base: '250, 250, 250',
  mantle: '234, 234, 235', crust: '219, 219, 220',
})

const everforestLight: CtpPalette = P({
  rosewater: '222, 177, 145', flamingo: '221, 181, 194', pink: '233, 130, 190', mauve: '184, 122, 156',
  red: '248, 85, 82', maroon: '248, 104, 82', peach: '245, 125, 38', yellow: '191, 152, 61',
  green: '137, 156, 64', teal: '86, 157, 121', sky: '86, 157, 139', sapphire: '86, 157, 138',
  blue: '90, 147, 162', lavender: '208, 161, 187', text: '92, 106, 114', subtext1: '114, 125, 132',
  subtext0: '135, 150, 134', overlay2: '147, 159, 145', overlay1: '164, 173, 158', overlay0: '223, 219, 200',
  surface2: '227, 224, 204', surface1: '237, 234, 213', surface0: '243, 239, 218', base: '253, 246, 227',
  mantle: '246, 241, 221', crust: '240, 237, 216',
})

const gruvboxLight: CtpPalette = P({
  rosewater: '243, 128, 25', flamingo: '207, 162, 174', pink: '177, 98, 118', mauve: '177, 98, 134',
  red: '204, 36, 29', maroon: '204, 49, 29', peach: '214, 93, 14', yellow: '215, 153, 33',
  green: '152, 151, 26', teal: '102, 152, 26', sky: '26, 152, 76', sapphire: '26, 133, 152',
  blue: '69, 133, 136', lavender: '146, 111, 175', text: '40, 40, 40', subtext1: '80, 73, 69',
  subtext0: '102, 92, 84', overlay2: '149, 131, 106', overlay1: '168, 153, 133', overlay0: '189, 174, 147',
  surface2: '214, 196, 161', surface1: '235, 219, 179', surface0: '242, 229, 188', base: '249, 245, 215',
  mantle: '236, 225, 196', crust: '230, 215, 178',
})

const luminescenceLight: CtpPalette = P({
  rosewater: '227, 130, 130', flamingo: '227, 130, 154', pink: '237, 172, 171', mauve: '212, 165, 198',
  red: '232, 152, 151', maroon: '209, 149, 148', peach: '229, 172, 154', yellow: '242, 203, 140',
  green: '148, 189, 117', teal: '98, 157, 142', sky: '98, 157, 157', sapphire: '117, 153, 189',
  blue: '130, 146, 201', lavender: '151, 151, 211', text: '101, 73, 65', subtext1: '122, 91, 82',
  subtext0: '122, 91, 82', overlay2: '157, 130, 123', overlay1: '194, 171, 163', overlay0: '223, 219, 200',
  surface2: '246, 243, 239', surface1: '225, 212, 208', surface0: '205, 183, 177', base: '242, 238, 232',
  mantle: '236, 231, 223', crust: '236, 231, 223',
})

const materialMintLight: CtpPalette = P({
  rosewater: '195, 126, 112', flamingo: '180, 78, 78', pink: '144, 61, 122', mauve: '98, 61, 143',
  red: '146, 62, 86', maroon: '145, 62, 76', peach: '195, 145, 114', yellow: '184, 164, 123',
  green: '51, 107, 46', teal: '71, 123, 133', sky: '47, 101, 110', sapphire: '45, 88, 108',
  blue: '46, 69, 109', lavender: '53, 60, 100', text: '5, 9, 10', subtext1: '11, 18, 20',
  subtext0: '18, 31, 33', overlay2: '29, 49, 53', overlay1: '43, 73, 80', overlay0: '57, 98, 106',
  surface2: '71, 122, 133', surface1: '86, 147, 159', surface0: '109, 165, 176', base: '189, 214, 219',
  mantle: '162, 198, 205', crust: '136, 182, 191',
})

const nordLight: CtpPalette = P({
  rosewater: '209, 135, 112', flamingo: '180, 142, 173', pink: '180, 142, 173', mauve: '180, 142, 173',
  red: '191, 97, 106', maroon: '191, 97, 106', peach: '208, 135, 112', yellow: '216, 172, 84',
  green: '136, 167, 108', teal: '121, 191, 142', sky: '143, 188, 187', sapphire: '136, 192, 208',
  blue: '94, 129, 172', lavender: '94, 129, 172', text: '46, 52, 64', subtext1: '59, 66, 82',
  subtext0: '67, 76, 94', overlay2: '76, 86, 106', overlay1: '86, 97, 118', overlay0: '143, 188, 187',
  surface2: '216, 222, 233', surface1: '216, 222, 233', surface0: '229, 233, 240', base: '236, 239, 244',
  mantle: '231, 235, 241', crust: '229, 233, 240',
})

const notionLight: CtpPalette = P({
  rosewater: '228, 122, 112', flamingo: '186, 82, 117', pink: '173, 26, 114', mauve: '105, 64, 165',
  red: '224, 62, 62', maroon: '224, 76, 62', peach: '217, 115, 13', yellow: '223, 171, 1',
  green: '15, 123, 108', teal: '15, 123, 123', sky: '11, 136, 153', sapphire: '11, 122, 153',
  blue: '11, 110, 153', lavender: '107, 84, 141', text: '55, 53, 47', subtext1: '77, 74, 66',
  subtext0: '99, 95, 84', overlay2: '121, 117, 103', overlay1: '123, 135, 142', overlay0: '145, 155, 161',
  surface2: '170, 177, 182', surface1: '189, 195, 199', surface0: '208, 212, 215', base: '255, 255, 255',
  mantle: '244, 245, 246', crust: '227, 230, 232',
})

const sandyBeachesLight: CtpPalette = P({
  rosewater: '228, 212, 196', flamingo: '214, 188, 174', pink: '200, 164, 152', mauve: '149, 136, 138',
  red: '166, 137, 123', maroon: '186, 144, 123', peach: '199, 161, 135', yellow: '212, 187, 160',
  green: '152, 150, 134', teal: '149, 156, 153', sky: '138, 155, 163', sapphire: '124, 133, 143',
  blue: '109, 111, 123', lavender: '135, 128, 142', text: '104, 88, 80', subtext1: '108, 92, 84',
  subtext0: '111, 96, 88', overlay2: '118, 103, 96', overlay1: '124, 110, 103', overlay0: '130, 117, 110',
  surface2: '205, 197, 193', surface1: '212, 205, 200', surface0: '222, 216, 209', base: '240, 234, 226',
  mantle: '237, 231, 224', crust: '230, 223, 216',
})

const solarizedLight: CtpPalette = P({
  rosewater: '227, 131, 89', flamingo: '241, 142, 168', pink: '211, 54, 130', mauve: '108, 113, 196',
  red: '220, 50, 47', maroon: '220, 60, 46', peach: '203, 75, 22', yellow: '181, 137, 0',
  green: '133, 153, 0', teal: '42, 161, 152', sky: '42, 145, 161', sapphire: '39, 168, 211',
  blue: '38, 139, 210', lavender: '139, 143, 222', text: '0, 43, 54', subtext1: '7, 54, 66',
  subtext0: '10, 76, 92', overlay2: '77, 96, 102', overlay1: '88, 110, 117', overlay0: '101, 123, 131',
  surface2: '131, 148, 150', surface1: '145, 160, 161', surface0: '173, 184, 184', base: '253, 246, 227',
  mantle: '237, 232, 214', crust: '224, 215, 184',
})

// ── Dark flavors ──────────────────────────────────────────────────────────────
const amoledDark: CtpPalette = P({
  rosewater: '245, 224, 220', flamingo: '242, 205, 205', pink: '245, 194, 231', mauve: '203, 166, 247',
  red: '243, 139, 168', maroon: '235, 160, 172', peach: '250, 179, 135', yellow: '249, 226, 175',
  green: '166, 227, 161', teal: '148, 226, 213', sky: '137, 220, 235', sapphire: '116, 199, 236',
  blue: '135, 176, 249', lavender: '180, 190, 254', text: '255, 255, 255', subtext1: '210, 210, 210',
  subtext0: '189, 189, 189', overlay2: '168, 168, 168', overlay1: '147, 147, 147', overlay0: '126, 126, 126',
  surface2: '80, 80, 80', surface1: '50, 50, 50', surface0: '30, 30, 30', base: '10, 10, 10',
  mantle: '5, 5, 5', crust: '0, 0, 0',
})

const atomDark: CtpPalette = P({
  rosewater: '226, 196, 168', flamingo: '238, 187, 216', pink: '221, 120, 211', mauve: '198, 120, 221',
  red: '224, 108, 117', maroon: '224, 121, 108', peach: '209, 154, 102', yellow: '229, 192, 123',
  green: '152, 195, 121', teal: '86, 182, 194', sky: '83, 185, 174', sapphire: '93, 185, 187',
  blue: '97, 175, 239', lavender: '170, 127, 183', text: '221, 222, 223', subtext1: '171, 171, 171',
  subtext0: '135, 135, 135', overlay2: '108, 115, 132', overlay1: '96, 102, 118', overlay0: '80, 85, 98',
  surface2: '66, 73, 88', surface1: '57, 63, 76', surface0: '48, 53, 64', base: '39, 43, 52',
  mantle: '33, 37, 43', crust: '26, 30, 36',
})

const coffeeDark: CtpPalette = P({
  rosewater: '236, 222, 213', flamingo: '234, 195, 214', pink: '234, 159, 194', mauve: '215, 159, 234',
  red: '234, 159, 159', maroon: '234, 169, 159', peach: '234, 178, 159', yellow: '234, 201, 159',
  green: '174, 213, 165', teal: '164, 234, 192', sky: '174, 224, 206', sapphire: '163, 225, 235',
  blue: '163, 200, 235', lavender: '182, 186, 226', text: '250, 218, 195', subtext1: '247, 204, 172',
  subtext0: '235, 192, 160', overlay2: '199, 163, 136', overlay1: '173, 144, 124', overlay0: '120, 102, 96',
  surface2: '94, 84, 86', surface1: '85, 77, 82', surface0: '76, 70, 78', base: '58, 56, 69',
  mantle: '47, 46, 56', crust: '38, 37, 45',
})

const draculaDark: CtpPalette = P({
  rosewater: '246, 201, 153', flamingo: '245, 189, 166', pink: '228, 157, 248', mauve: '189, 147, 249',
  red: '255, 85, 85', maroon: '230, 102, 102', peach: '255, 184, 108', yellow: '241, 250, 140',
  green: '80, 250, 123', teal: '104, 219, 211', sky: '139, 233, 253', sapphire: '104, 197, 240',
  blue: '95, 126, 222', lavender: '197, 146, 222', text: '248, 248, 242', subtext1: '211, 211, 197',
  subtext0: '191, 191, 181', overlay2: '139, 143, 167', overlay1: '110, 114, 145', overlay0: '88, 92, 116',
  surface2: '68, 71, 90', surface1: '56, 59, 76', surface0: '48, 50, 65', base: '40, 42, 54',
  mantle: '33, 34, 44', crust: '26, 27, 35',
})

const everforestDark: CtpPalette = P({
  rosewater: '231, 198, 155', flamingo: '224, 186, 207', pink: '227, 150, 174', mauve: '184, 123, 157',
  red: '218, 99, 98', maroon: '218, 116, 98', peach: '215, 127, 72', yellow: '191, 152, 61',
  green: '137, 156, 64', teal: '86, 157, 121', sky: '86, 157, 144', sapphire: '86, 156, 157',
  blue: '90, 147, 162', lavender: '180, 144, 202', text: '211, 198, 170', subtext1: '182, 192, 180',
  subtext0: '154, 167, 157', overlay2: '133, 146, 137', overlay1: '127, 137, 125', overlay0: '81, 91, 97',
  surface2: '74, 85, 91', surface1: '64, 76, 81', surface0: '55, 66, 71', base: '47, 56, 62',
  mantle: '39, 47, 52', crust: '34, 40, 44',
})

const genericDark: CtpPalette = P({
  rosewater: '245, 224, 220', flamingo: '242, 205, 205', pink: '245, 194, 231', mauve: '203, 166, 247',
  red: '243, 139, 168', maroon: '235, 160, 172', peach: '250, 179, 135', yellow: '249, 226, 175',
  green: '166, 227, 161', teal: '148, 226, 213', sky: '137, 220, 235', sapphire: '116, 199, 236',
  blue: '135, 176, 249', lavender: '180, 190, 254', text: '255, 255, 255', subtext1: '210, 210, 210',
  subtext0: '189, 189, 189', overlay2: '168, 168, 168', overlay1: '147, 147, 147', overlay0: '126, 126, 126',
  surface2: '105, 105, 105', surface1: '84, 84, 84', surface0: '63, 63, 63', base: '42, 42, 42',
  mantle: '21, 21, 21', crust: '0, 0, 0',
})

const gruvboxDark: CtpPalette = P({
  rosewater: '243, 128, 25', flamingo: '207, 162, 174', pink: '177, 98, 118', mauve: '177, 98, 134',
  red: '204, 36, 29', maroon: '204, 49, 29', peach: '214, 93, 14', yellow: '215, 153, 33',
  green: '152, 151, 26', teal: '102, 152, 26', sky: '26, 152, 76', sapphire: '26, 133, 152',
  blue: '69, 133, 136', lavender: '146, 111, 175', text: '251, 241, 199', subtext1: '213, 196, 161',
  subtext0: '189, 174, 147', overlay2: '151, 137, 125', overlay1: '124, 111, 100', overlay0: '102, 92, 84',
  surface2: '80, 73, 69', surface1: '60, 56, 54', surface0: '50, 48, 47', base: '40, 40, 40',
  mantle: '29, 32, 33', crust: '19, 21, 22',
})

const kanagawaDark: CtpPalette = P({
  rosewater: '255, 200, 148', flamingo: '210, 126, 129', pink: '210, 126, 153', mauve: '149, 127, 184',
  red: '255, 93, 98', maroon: '228, 104, 118', peach: '255, 160, 102', yellow: '230, 195, 132',
  green: '152, 187, 108', teal: '122, 168, 159', sky: '163, 212, 213', sapphire: '127, 180, 202',
  blue: '126, 156, 216', lavender: '147, 138, 169', text: '220, 215, 186', subtext1: '212, 206, 170',
  subtext0: '200, 192, 147', overlay2: '95, 95, 124', overlay1: '84, 84, 109', overlay0: '73, 73, 95',
  surface2: '62, 62, 81', surface1: '54, 54, 69', surface0: '42, 42, 55', base: '31, 31, 40',
  mantle: '22, 22, 29', crust: '11, 11, 15',
})

const materialMintDark: CtpPalette = P({
  rosewater: '245, 224, 220', flamingo: '242, 205, 205', pink: '245, 194, 231', mauve: '203, 166, 247',
  red: '243, 139, 168', maroon: '235, 160, 172', peach: '250, 179, 135', yellow: '249, 226, 175',
  green: '166, 227, 161', teal: '189, 214, 219', sky: '137, 220, 235', sapphire: '116, 199, 236',
  blue: '135, 176, 249', lavender: '180, 190, 254', text: '189, 214, 219', subtext1: '162, 198, 205',
  subtext0: '136, 182, 191', overlay2: '109, 165, 176', overlay1: '86, 147, 159', overlay0: '71, 122, 133',
  surface2: '57, 98, 106', surface1: '43, 73, 80', surface0: '29, 49, 53', base: '18, 31, 33',
  mantle: '11, 18, 20', crust: '5, 9, 10',
})

const nordDark: CtpPalette = P({
  rosewater: '226, 191, 169', flamingo: '239, 171, 150', pink: '214, 163, 222', mauve: '180, 142, 173',
  red: '191, 97, 106', maroon: '191, 108, 97', peach: '208, 135, 112', yellow: '235, 203, 139',
  green: '163, 190, 140', teal: '143, 188, 187', sky: '136, 192, 208', sapphire: '129, 161, 193',
  blue: '94, 129, 172', lavender: '192, 167, 187', text: '236, 239, 244', subtext1: '229, 233, 240',
  subtext0: '217, 222, 232', overlay2: '196, 201, 212', overlay1: '172, 180, 195', overlay0: '149, 158, 178',
  surface2: '125, 137, 161', surface1: '103, 116, 142', surface0: '77, 87, 106', base: '67, 76, 94',
  mantle: '59, 66, 82', crust: '46, 52, 64',
})

const nordDarker: CtpPalette = P({
  rosewater: '226, 191, 169', flamingo: '239, 171, 150', pink: '214, 163, 222', mauve: '180, 142, 173',
  red: '191, 97, 106', maroon: '191, 108, 97', peach: '208, 135, 112', yellow: '235, 203, 139',
  green: '163, 190, 140', teal: '143, 188, 187', sky: '136, 192, 208', sapphire: '129, 161, 193',
  blue: '94, 129, 172', lavender: '192, 167, 187', text: '236, 239, 244', subtext1: '229, 233, 240',
  subtext0: '217, 222, 232', overlay2: '196, 201, 212', overlay1: '172, 180, 195', overlay0: '149, 158, 178',
  surface2: '125, 137, 161', surface1: '67, 76, 94', surface0: '59, 66, 82', base: '46, 52, 64',
  mantle: '39, 43, 53', crust: '30, 34, 41',
})

const notionDark: CtpPalette = P({
  rosewater: '246, 174, 138', flamingo: '248, 160, 154', pink: '226, 85, 161', mauve: '154, 109, 215',
  red: '255, 115, 105', maroon: '255, 120, 105', peach: '255, 163, 68', yellow: '255, 220, 73',
  green: '77, 171, 154', teal: '77, 171, 165', sky: '77, 166, 171', sapphire: '82, 178, 202',
  blue: '82, 156, 202', lavender: '156, 125, 198', text: '227, 230, 232', subtext1: '222, 225, 227',
  subtext0: '200, 205, 208', overlay2: '178, 185, 189', overlay1: '156, 165, 171', overlay0: '134, 145, 152',
  surface2: '113, 125, 132', surface1: '94, 104, 110', surface0: '75, 83, 88', base: '61, 68, 72',
  mantle: '54, 60, 63', crust: '47, 52, 55',
})

const roseboxDark: CtpPalette = P({
  rosewater: '165, 117, 98', flamingo: '165, 117, 98', pink: '180, 142, 173', mauve: '180, 142, 173',
  red: '191, 97, 106', maroon: '191, 97, 106', peach: '208, 135, 112', yellow: '235, 203, 139',
  green: '163, 190, 140', teal: '143, 188, 187', sky: '136, 192, 208', sapphire: '136, 192, 208',
  blue: '94, 129, 172', lavender: '129, 161, 193', text: '163, 165, 170', subtext1: '135, 137, 145',
  subtext0: '110, 113, 119', overlay2: '92, 92, 92', overlay1: '82, 82, 82', overlay0: '71, 71, 71',
  surface2: '61, 61, 61', surface1: '51, 51, 51', surface0: '40, 40, 40', base: '35, 35, 35',
  mantle: '30, 30, 30', crust: '25, 25, 25',
})

const rosepineDark: CtpPalette = P({
  rosewater: '243, 215, 204', flamingo: '235, 188, 186', pink: '223, 167, 231', mauve: '196, 167, 231',
  red: '235, 111, 146', maroon: '235, 122, 111', peach: '235, 159, 111', yellow: '246, 193, 119',
  green: '114, 182, 156', teal: '156, 207, 216', sky: '49, 116, 143', sapphire: '68, 132, 171',
  blue: '76, 127, 169', lavender: '210, 193, 231', text: '224, 222, 244', subtext1: '144, 140, 170',
  subtext0: '110, 106, 134', overlay2: '82, 79, 103', overlay1: '64, 61, 82', overlay0: '54, 50, 83',
  surface2: '46, 42, 70', surface1: '33, 32, 46', surface0: '31, 29, 46', base: '25, 23, 36',
  mantle: '17, 16, 25', crust: '11, 10, 16',
})

const royalVelvetDark: CtpPalette = P({
  rosewater: '246, 201, 153', flamingo: '245, 189, 166', pink: '228, 157, 248', mauve: '197, 146, 222',
  red: '240, 120, 160', maroon: '230, 102, 102', peach: '230, 195, 125', yellow: '241, 250, 140',
  green: '130, 235, 130', teal: '114, 224, 214', sky: '139, 233, 253', sapphire: '104, 197, 240',
  blue: '95, 126, 222', lavender: '154, 141, 247', text: '248, 248, 242', subtext1: '211, 211, 197',
  subtext0: '191, 191, 181', overlay2: '139, 143, 167', overlay1: '110, 114, 145', overlay0: '88, 92, 116',
  surface2: '68, 71, 90', surface1: '56, 59, 76', surface0: '48, 50, 65', base: '30, 30, 36',
  mantle: '25, 25, 30', crust: '20, 20, 25',
})

const solarizedDark: CtpPalette = P({
  rosewater: '227, 131, 89', flamingo: '241, 142, 168', pink: '211, 54, 130', mauve: '108, 113, 196',
  red: '220, 50, 47', maroon: '220, 60, 46', peach: '203, 75, 22', yellow: '181, 137, 0',
  green: '133, 153, 0', teal: '42, 161, 152', sky: '42, 145, 161', sapphire: '39, 168, 211',
  blue: '38, 139, 210', lavender: '139, 143, 222', text: '253, 246, 227', subtext1: '237, 232, 214',
  subtext0: '225, 215, 183', overlay2: '147, 161, 161', overlay1: '117, 159, 163', overlay0: '106, 168, 175',
  surface2: '51, 129, 153', surface1: '38, 97, 115', surface0: '10, 76, 92', base: '7, 54, 66',
  mantle: '0, 43, 54', crust: '0, 33, 41',
})

const THEMES: Record<string, HelixThemeDef> = {
  'ctp-atom-light': { id: 'ctp-atom-light', label: 'Atom 蓝白', mode: 'light', ctp: atomLight, pair: 'ctp-atom-dark' },
  'ctp-everforest-light': { id: 'ctp-everforest-light', label: 'Everforest 淡绿', mode: 'light', ctp: everforestLight, pair: 'ctp-everforest-dark' },
  'ctp-gruvbox-light': { id: 'ctp-gruvbox-light', label: 'Gruvbox 棕橙', mode: 'light', ctp: gruvboxLight, pair: 'ctp-gruvbox-dark' },
  'ctp-luminescence-light': { id: 'ctp-luminescence-light', label: 'Luminescence 桃花', mode: 'light', ctp: luminescenceLight },
  'ctp-material-mint-light': { id: 'ctp-material-mint-light', label: 'Material Mint 薄荷', mode: 'light', ctp: materialMintLight, pair: 'ctp-material-mint-dark' },
  'ctp-nord-light': { id: 'ctp-nord-light', label: 'Nord 蓝雪', mode: 'light', ctp: nordLight, pair: 'ctp-nord-dark' },
  'ctp-notion-light': { id: 'ctp-notion-light', label: 'Notion 红白', mode: 'light', ctp: notionLight, pair: 'ctp-notion-dark' },
  'ctp-sandy-beaches-light': { id: 'ctp-sandy-beaches-light', label: 'Sandy Beaches 沙滩', mode: 'light', ctp: sandyBeachesLight },
  'ctp-solarized-light': { id: 'ctp-solarized-light', label: 'Solarized 橙红', mode: 'light', ctp: solarizedLight, pair: 'ctp-solarized-dark' },

  'ctp-amoled-dark': { id: 'ctp-amoled-dark', label: 'AMOLED 纯黑', mode: 'dark', ctp: amoledDark },
  'ctp-atom-dark': { id: 'ctp-atom-dark', label: 'Atom 暗蓝', mode: 'dark', ctp: atomDark, pair: 'ctp-atom-light' },
  'ctp-coffee-dark': { id: 'ctp-coffee-dark', label: 'Coffee 咖啡', mode: 'dark', ctp: coffeeDark },
  'ctp-dracula': { id: 'ctp-dracula', label: 'Dracula 橙', mode: 'dark', ctp: draculaDark },
  'ctp-everforest-dark': { id: 'ctp-everforest-dark', label: 'Everforest 墨绿', mode: 'dark', ctp: everforestDark, pair: 'ctp-everforest-light' },
  'ctp-generic-dark': { id: 'ctp-generic-dark', label: 'Generic 灰黑', mode: 'dark', ctp: genericDark },
  'ctp-gruvbox-dark': { id: 'ctp-gruvbox-dark', label: 'Gruvbox 活力橙', mode: 'dark', ctp: gruvboxDark, pair: 'ctp-gruvbox-light' },
  'ctp-kanagawa-dark': { id: 'ctp-kanagawa-dark', label: 'Kanagawa 暗橙', mode: 'dark', ctp: kanagawaDark },
  'ctp-material-mint-dark': { id: 'ctp-material-mint-dark', label: 'Material Mint 暗薄荷', mode: 'dark', ctp: materialMintDark, pair: 'ctp-material-mint-light' },
  'ctp-nord-dark': { id: 'ctp-nord-dark', label: 'Nord 雪蓝', mode: 'dark', ctp: nordDark, pair: 'ctp-nord-light' },
  'ctp-nord-darker': { id: 'ctp-nord-darker', label: 'Nord 更暗', mode: 'dark', ctp: nordDarker, pair: 'ctp-nord-light' },
  'ctp-notion-dark': { id: 'ctp-notion-dark', label: 'Notion 暗橙', mode: 'dark', ctp: notionDark, pair: 'ctp-notion-light' },
  'ctp-rosebox': { id: 'ctp-rosebox', label: 'Rosebox 暖棕', mode: 'dark', ctp: roseboxDark },
  'ctp-rosepine-dark': { id: 'ctp-rosepine-dark', label: 'Rosé Pine 玫瑰', mode: 'dark', ctp: rosepineDark },
  'ctp-royal-velvet': { id: 'ctp-royal-velvet', label: 'Royal Velvet 紫绒', mode: 'dark', ctp: royalVelvetDark },
  'ctp-solarized-dark': { id: 'ctp-solarized-dark', label: 'Solarized 护眼蓝', mode: 'dark', ctp: solarizedDark, pair: 'ctp-solarized-light' },
}

const DEFAULT_THEME_STYLE = 'default'

/** Returns the theme definition, or null for the built-in cream default. */
export function getThemeMeta(styleId: string | null | undefined): HelixThemeDef | null {
  if (!styleId || styleId === DEFAULT_THEME_STYLE) return null
  return THEMES[styleId] ?? null
}

const rgb = (triplet: string): string => `rgb(${triplet.split(',').map((s) => s.trim()).join(' ')})`

/** Maps a Catppuccin palette onto Helix's shadcn-style CSS custom properties. */
function buildHelixVars(c: CtpPalette): Record<string, string> {
  return {
    '--background': rgb(c.base),
    '--foreground': rgb(c.text),
    '--card': rgb(c.mantle),
    '--card-foreground': rgb(c.text),
    '--popover': rgb(c.crust),
    '--popover-foreground': rgb(c.text),
    '--primary': rgb(c.blue),
    '--primary-foreground': rgb(c.base),
    '--secondary': rgb(c.surface0),
    '--secondary-foreground': rgb(c.text),
    '--muted': rgb(c.surface0),
    '--muted-foreground': rgb(c.subtext0),
    '--accent': rgb(c.surface0),
    '--accent-foreground': rgb(c.text),
    '--destructive': rgb(c.red),
    '--border': rgb(c.surface0),
    '--input': rgb(c.surface0),
    '--ring': rgb(c.blue),
    '--link': rgb(c.mauve),
    '--chart-1': rgb(c.blue),
    '--chart-2': rgb(c.green),
    '--chart-3': rgb(c.peach),
    '--chart-4': rgb(c.mauve),
    '--chart-5': rgb(c.teal),
    '--sidebar': rgb(c.mantle),
    '--sidebar-foreground': rgb(c.text),
    '--sidebar-primary': rgb(c.blue),
    '--sidebar-primary-foreground': rgb(c.base),
    '--sidebar-accent': rgb(c.surface0),
    '--sidebar-accent-foreground': rgb(c.text),
    '--sidebar-border': rgb(c.surface0),
    '--sidebar-ring': rgb(c.blue),
  }
}

const VAR_NAMES = Object.keys(buildHelixVars(atomLight))

/**
 * Applies a theme style by writing inline CSS variables onto <html>.
 * Inline styles outrank globals.css `:root` / `.dark`, so a flavor fully
 * overrides the built-in cream palette. `null` / 'default' clears overrides
 * and lets the cream light/dark theme take over again.
 */
export function applyHelixPalette(styleId: string | null | undefined): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  const meta = getThemeMeta(styleId)
  if (!meta) {
    VAR_NAMES.forEach((name) => root.style.removeProperty(name))
    root.style.colorScheme = ''
    return
  }
  if (meta.mode === 'dark') {
    root.classList.add('dark')
    root.style.colorScheme = 'dark'
  } else {
    root.classList.remove('dark')
    root.style.colorScheme = 'light'
  }
  const vars = buildHelixVars(meta.ctp)
  for (const [name, value] of Object.entries(vars)) {
    root.style.setProperty(name, value)
  }
}

/** Dropdown option groups for the appearance panel. */
export const THEME_SELECT_GROUPS: { label: string; options: { value: string; label: string }[] }[] = [
  {
    label: '内置',
    options: [{ value: DEFAULT_THEME_STYLE, label: '默认（奶油）' }],
  },
  {
    label: '浅色',
    options: [
      { value: 'ctp-atom-light', label: 'Atom 蓝白' },
      { value: 'ctp-everforest-light', label: 'Everforest 淡绿' },
      { value: 'ctp-gruvbox-light', label: 'Gruvbox 棕橙' },
      { value: 'ctp-luminescence-light', label: 'Luminescence 桃花' },
      { value: 'ctp-material-mint-light', label: 'Material Mint 薄荷' },
      { value: 'ctp-nord-light', label: 'Nord 蓝雪' },
      { value: 'ctp-notion-light', label: 'Notion 红白' },
      { value: 'ctp-sandy-beaches-light', label: 'Sandy Beaches 沙滩' },
      { value: 'ctp-solarized-light', label: 'Solarized 橙红' },
    ],
  },
  {
    label: '深色',
    options: [
      { value: 'ctp-amoled-dark', label: 'AMOLED 纯黑' },
      { value: 'ctp-atom-dark', label: 'Atom 暗蓝' },
      { value: 'ctp-coffee-dark', label: 'Coffee 咖啡' },
      { value: 'ctp-dracula', label: 'Dracula 橙' },
      { value: 'ctp-everforest-dark', label: 'Everforest 墨绿' },
      { value: 'ctp-generic-dark', label: 'Generic 灰黑' },
      { value: 'ctp-gruvbox-dark', label: 'Gruvbox 活力橙' },
      { value: 'ctp-kanagawa-dark', label: 'Kanagawa 暗橙' },
      { value: 'ctp-material-mint-dark', label: 'Material Mint 暗薄荷' },
      { value: 'ctp-nord-dark', label: 'Nord 雪蓝' },
      { value: 'ctp-nord-darker', label: 'Nord 更暗' },
      { value: 'ctp-notion-dark', label: 'Notion 暗橙' },
      { value: 'ctp-rosebox', label: 'Rosebox 暖棕' },
      { value: 'ctp-rosepine-dark', label: 'Rosé Pine 玫瑰' },
      { value: 'ctp-royal-velvet', label: 'Royal Velvet 紫绒' },
      { value: 'ctp-solarized-dark', label: 'Solarized 护眼蓝' },
    ],
  },
]
