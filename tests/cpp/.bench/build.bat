@echo off
call "C:\Program Files\Microsoft Visual Studio\2022\Community\VC\Auxiliary\Build\vcvars64.bat" >nul
cl /nologo /O2 /std:c++17 /EHsc /W3 ^
   /I "D:\My_Project\Cocos_Project\virtual-piano\native\engine\common\third_party" ^
   "D:\My_Project\Cocos_Project\virtual-piano\tests\cpp\.bench\drflac_bench.cpp" ^
   /Fe:"D:\My_Project\Cocos_Project\virtual-piano\tests\cpp\.bench\drflac_bench.exe" ^
   /Fo:"D:\My_Project\Cocos_Project\virtual-piano\tests\cpp\.bench\\"
